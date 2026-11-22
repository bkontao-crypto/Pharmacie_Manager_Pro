'use strict';
/**
 * Pharmacie multi-sites : l'Admin de la pharmacie PRINCIPALE gère ses sous-pharmacies (dans la limite du quota fixé par le Superadmin)
 * et consulte des rapports consolidés. Tout est évalué sur SA pharmacie (req.user.homeTenantId), même s'il travaille
 * dans une sous-pharmacie. Aucune donnée patient ici ; l'accès aux dossiers d'une sous-pharmacie passe par X-Pharmacy-Id
 * et par l'autorisation de son gérant local (routes/site.js, lib/sites.js).
 */
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { requireTimezone, assertKnownToDb } = require('../lib/tz');
const { authenticate, blockIfMustChange, requireGroupAdmin } = require('../middleware/auth');
const { overviewData, period } = require('./rapports');
const { transferNumber } = require('../lib/transfers');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireGroupAdmin);

const home = (req) => req.user.homeTenantId;
const gaudit = (c, req, action, entityId, meta) => audit(c, { tenantId: home(req), userId: req.user.id, action, entity: 'tenant', entityId, meta, ip: req.ip });
const r2 = (x) => Math.round(x * 100) / 100;

// GET /api/groupe/sites — la pharmacie principale, ses sous-pharmacies, le quota
router.get('/sites', wrap(async (req, res) => {
  const d = await tx({ system: true }, async (c) => {
    const sites = (await c.query(`
      SELECT t.id, t.name, t.city, t.phone, t.email, t.timezone, t.status, t.parent_id, t.max_subsites, t.group_patient_access,
             COALESCE((SELECT array_agg(m.module_key ORDER BY m.module_key) FROM tenant_modules m WHERE m.tenant_id = t.id), '{}') AS modules
        FROM tenants t WHERE t.id = $1 OR t.parent_id = $1 ORDER BY (t.parent_id IS NOT NULL), t.created_at`, [home(req)])).rows;
    const ids = sites.map((s) => s.id);
    const counts = (await c.query('SELECT tenant_id, count(*)::int AS n FROM users WHERE tenant_id = ANY($1::uuid[]) AND is_active GROUP BY tenant_id', [ids])).rows;
    const managers = (await c.query(`SELECT tenant_id, full_name, email, is_active FROM users WHERE role = 'gerant' AND tenant_id = ANY($1::uuid[]) ORDER BY is_active DESC, created_at`, [ids])).rows;
    return { sites, counts, managers };
  });
  const main = d.sites.find((s) => s.id === home(req));
  const mainMods = new Set(main.modules);
  const out = d.sites.map((s) => ({
    id: s.id, name: s.name, city: s.city, phone: s.phone, email: s.email, timezone: s.timezone, status: s.status, isMain: !s.parent_id,
    patientAccess: !s.parent_id ? true : s.group_patient_access,                      // pour la principale : sa propre pharmacie
    modules: s.parent_id ? s.modules.filter((m) => mainMods.has(m)) : s.modules,
    userCount: d.counts.find((x) => x.tenant_id === s.id)?.n || 0,
    manager: d.managers.find((m) => m.tenant_id === s.id) ? (({ full_name, email, is_active }) => ({ fullName: full_name, email, isActive: is_active }))(d.managers.find((m) => m.tenant_id === s.id)) : null,
  }));
  const used = out.filter((s) => !s.isMain).length;
  res.json({ group: { maxSites: main.max_subsites, used, remaining: Math.max(0, main.max_subsites - used) }, sites: out });
}));

// POST /api/groupe/sites — ouverture d'une sous-pharmacie (quota vérifié sous verrou, puis par la base)
router.post('/sites', wrap(async (req, res) => {
  const b = req.body || {};
  const name = v.str(b.name, { max: 120, field: 'nom' });
  const f = {
    city: v.optStr(b.city, { max: 80, field: 'ville' }), phone: v.optStr(b.phone, { max: 40, field: 'téléphone' }),
    email: b.email ? v.email(b.email) : null, tz: b.timezone ? requireTimezone(b.timezone) : null,
  };
  const base = v.slugify(name) || 'pharmacie';
  const site = await tx({ system: true }, async (c) => {
    const parent = (await c.query('SELECT id, plan, country, timezone, max_subsites FROM tenants WHERE id = $1 FOR UPDATE', [home(req)])).rows[0];
    const used = (await c.query('SELECT count(*)::int AS n FROM tenants WHERE parent_id = $1', [parent.id])).rows[0].n;
    if (used >= parent.max_subsites) throw new AppError(409, `Quota atteint : ${parent.max_subsites} sous-pharmacie(s) autorisée(s). Contactez l’administrateur de la plateforme pour l’augmenter.`, 'SITE_QUOTA');
    const zone = f.tz || parent.timezone; await assertKnownToDb(c, zone);
    let slug = base;
    for (let i = 2; (await c.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount; i++) slug = `${base}-${i}`;
    const t = (await c.query(
      `INSERT INTO tenants (name, slug, city, country, phone, email, plan, subscription_start, timezone, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(now() AT TIME ZONE $8)::date,$8,$9) RETURNING id, name, city, timezone, status`,
      [name, slug, f.city, parent.country, f.phone, f.email, parent.plan, zone, parent.id])).rows[0];
    await c.query('INSERT INTO tenant_modules (tenant_id, module_key) SELECT $1, module_key FROM tenant_modules WHERE tenant_id = $2', [t.id, parent.id]);
    await gaudit(c, req, 'group.site_created', t.id, { name, timezone: zone });
    return t;
  });
  res.status(201).json({ site });
}));

// PATCH /api/groupe/sites/:id — coordonnées et fuseau (la pharmacie principale ou l'une de ses sous-pharmacies)
router.patch('/sites/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {};
  const sets = []; const vals = [id];
  const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) add('name', v.str(b.name, { max: 120, field: 'nom' }));
  if (b.city !== undefined) add('city', v.optStr(b.city, { max: 80, field: 'ville' }));
  if (b.phone !== undefined) add('phone', v.optStr(b.phone, { max: 40, field: 'téléphone' }));
  if (b.email !== undefined) add('email', b.email ? v.email(b.email) : null);
  const tz = b.timezone !== undefined ? requireTimezone(b.timezone) : null; if (tz) add('timezone', tz);
  if (!sets.length) throw new AppError(400, 'Aucune modification');
  const site = await tx({ system: true }, async (c) => {
    // appartenance au groupe vérifiée ; réponse identique si la pharmacie n'existe pas ou n'est pas à vous
    if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1 AND (id = $2 OR parent_id = $2)', [id, home(req)])).rowCount) throw new AppError(404, 'Pharmacie introuvable');
    if (tz) await assertKnownToDb(c, tz);
    const t = (await c.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, city, phone, email, timezone, status`, vals)).rows[0];
    await gaudit(c, req, 'group.site_updated', id, b);
    return t;
  });
  res.json({ site });
}));

// GET /api/groupe/overview?from&to — chiffres consolidés (chaque pharmacie calcule ses jours dans SON fuseau)
router.get('/overview', wrap(async (req, res) => {
  const { from, to } = period(req.query, req.user.homeTimezone);
  const sites = await tx({ system: true }, async (c) => {
    const rows = (await c.query('SELECT t.id, t.name, t.timezone, t.parent_id, t.status FROM tenants t WHERE t.id = $1 OR t.parent_id = $1 ORDER BY (t.parent_id IS NOT NULL), t.name', [home(req)])).rows;
    const mods = (await c.query('SELECT tenant_id, module_key FROM tenant_modules WHERE tenant_id = ANY($1::uuid[])', [rows.map((r) => r.id)])).rows;
    const has = (id, m) => mods.some((x) => x.tenant_id === id && x.module_key === m);
    return rows.map((r) => ({ ...r, reports: has(r.id, 'rapports') && (!r.parent_id || has(home(req), 'rapports')) }));
  });
  const out = []; const skipped = [];
  for (const s of sites) {
    if (s.status !== 'active') { skipped.push({ id: s.id, name: s.name, reason: 'Pharmacie suspendue ou expirée' }); continue; }
    if (!s.reports) { skipped.push({ id: s.id, name: s.name, reason: 'Module « Rapports & Pilotage » non activé' }); continue; }
    const o = await tx({ tenantId: s.id, timezone: s.timezone, actingFrom: s.parent_id ? home(req) : null }, (c) => overviewData(c, from, to));
    out.push({ id: s.id, name: s.name, isMain: !s.parent_id, timezone: s.timezone, kpis: o.kpis, stockValuation: o.stockValuation });
  }
  const sum = (f) => r2(out.reduce((t, s) => t + f(s), 0));
  const revenue = sum((s) => s.kpis.revenue); const margin = sum((s) => s.kpis.margin); const salesCount = out.reduce((t, s) => t + s.kpis.salesCount, 0);
  res.json({
    period: { from, to }, sites: out, skipped,
    totals: { revenue, salesCount, margin, marginPct: revenue ? Math.round((margin / revenue) * 1000) / 10 : 0, avgBasket: salesCount ? r2(revenue / salesCount) : 0,
      discounts: sum((s) => s.kpis.discounts), refunded: sum((s) => s.kpis.refunded), stockValue: sum((s) => s.stockValuation.value), expiredValue: sum((s) => s.stockValuation.expiredValue) },
  });
}));

// GET /api/groupe/transfers — derniers transferts de stock entre les pharmacies du groupe (lecture seule)
router.get('/transfers', wrap(async (req, res) => {
  const rows = await tx({ system: true }, async (c) => (await c.query(
    `SELECT t.id, t.number, t.status, t.created_at, t.sent_at, t.received_at,
            (SELECT name FROM tenants f WHERE f.id = t.from_tenant_id) AS from_name, (SELECT name FROM tenants d WHERE d.id = t.to_tenant_id) AS to_name,
            (SELECT count(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS line_count,
            (SELECT COALESCE(SUM(l.quantity), 0)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS units
       FROM stock_transfers t
      WHERE t.from_tenant_id IN (SELECT x.id FROM tenants x WHERE x.id = $1 OR x.parent_id = $1)
      ORDER BY t.created_at DESC LIMIT 100`, [home(req)])).rows);
  res.json({ transfers: rows.map((r) => ({ id: r.id, number: transferNumber(r.number), status: r.status, fromName: r.from_name, toName: r.to_name, lineCount: r.line_count, units: r.units, createdAt: r.created_at, sentAt: r.sent_at, receivedAt: r.received_at })) });
}));

module.exports = router;
