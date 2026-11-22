'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { tempPassword } = require('../lib/crypto');
const { MODULES, MODULE_KEYS } = require('../lib/permissions');
const { importReference, parseImportBody } = require('../lib/reference');
const { authenticate, blockIfMustChange, requireSuperadmin } = require('../middleware/auth');

const { requireTimezone: tzOrFail, assertKnownToDb: tzKnownToDb } = require('../lib/tz');
const router = express.Router();
router.use(authenticate, blockIfMustChange, requireSuperadmin);

const sysAudit = (c, req, action, tenantId, entityId, meta) =>
  audit(c, { tenantId, userId: req.user.id, action, entity: 'tenant', entityId, meta, ip: req.ip });

// GET /api/superadmin/modules — catalogue des modules activables
router.get('/modules', (req, res) => {
  res.json({ modules: MODULES.map(({ key, label, description, is_core }) => ({ key, label, description, isCore: is_core })) });
});

// GET /api/superadmin/dashboard — vue globale
router.get('/dashboard', wrap(async (req, res) => {
  const data = await tx({ system: true }, async (c) => {
    const t = (await c.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'active' AND (subscription_end IS NULL OR subscription_end >= CURRENT_DATE))::int AS active,
             count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
             count(*) FILTER (WHERE status = 'expired' OR (subscription_end IS NOT NULL AND subscription_end < CURRENT_DATE))::int AS expired,
             count(*) FILTER (WHERE subscription_end BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS expiring_soon
        FROM tenants`)).rows[0];
    const u = (await c.query(`SELECT count(*)::int AS total FROM users WHERE role <> 'superadmin' AND is_active`)).rows[0];
    const mods = (await c.query(`SELECT module_key, count(*)::int AS n FROM tenant_modules GROUP BY module_key ORDER BY n DESC`)).rows;
    const recent = (await c.query(`SELECT id, name, city, created_at FROM tenants ORDER BY created_at DESC LIMIT 5`)).rows;
    return { tenants: t, localUsers: u.total, moduleAdoption: mods, recentTenants: recent };
  });
  res.json(data);
}));

// GET /api/superadmin/tenants
router.get('/tenants', wrap(async (req, res) => {
  const rows = await tx({ system: true }, async (c) => (await c.query(`
    SELECT t.id, t.name, t.slug, t.city, t.country, t.phone, t.email, t.plan, t.status, t.timezone,
           t.parent_id, t.max_subsites, t.group_patient_access,
           (SELECT count(*)::int FROM tenants ch WHERE ch.parent_id = t.id) AS site_count,
           t.subscription_start, t.subscription_end, t.created_at,
           COALESCE((SELECT array_agg(module_key ORDER BY module_key) FROM tenant_modules m WHERE m.tenant_id = t.id), '{}') AS modules,
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.is_active) AS user_count,
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin' AND u.is_active) AS admin_count
      FROM tenants t ORDER BY t.created_at DESC`)).rows);
  res.json({ tenants: rows });
}));

// POST /api/superadmin/tenants — création d'une pharmacie (abonnement + modules initiaux)
router.post('/tenants', wrap(async (req, res) => {
  const b = req.body || {};
  const name = v.str(b.name, { max: 120, field: 'nom' });
  const modules = b.modules === undefined ? [] : v.stringArray(b.modules, 'modules').filter((m) => m !== 'core');
  if (modules.some((m) => !MODULE_KEYS.includes(m))) throw new AppError(400, 'Module inconnu');
  const row = {
    city: v.optStr(b.city, { max: 80, field: 'ville' }), phone: v.optStr(b.phone, { max: 40, field: 'téléphone' }),
    email: b.email ? v.email(b.email) : null, plan: v.optStr(b.plan, { max: 40, field: 'plan' }) || 'starter',
    start: v.date(b.subscriptionStart, 'début abonnement'), end: v.date(b.subscriptionEnd, 'fin abonnement'),
    timezone: b.timezone === undefined || b.timezone === '' ? 'UTC' : tzOrFail(b.timezone),
    maxSubsites: b.maxSubsites === undefined || b.maxSubsites === '' ? 0 : v.int(b.maxSubsites, { min: 0, max: 100, field: 'sous-pharmacies autorisées' }),
  };
  const base = v.slugify(name) || 'pharmacie';

  const tenant = await tx({ system: true }, async (c) => {
    await tzKnownToDb(c, row.timezone);
    let slug = base;
    for (let i = 2; (await c.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rowCount; i++) slug = `${base}-${i}`;
    const t = (await c.query(
      `INSERT INTO tenants (name, slug, city, phone, email, plan, subscription_start, subscription_end, timezone, max_subsites)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, (now() AT TIME ZONE $9)::date), $8, $9, $10) RETURNING *`,
      [name, slug, row.city, row.phone, row.email, row.plan, row.start, row.end, row.timezone, row.maxSubsites])).rows[0];
    for (const m of modules) await c.query('INSERT INTO tenant_modules (tenant_id, module_key) VALUES ($1,$2)', [t.id, m]);
    await sysAudit(c, req, 'tenant.created', t.id, t.id, { name, modules });
    return t;
  });
  res.status(201).json({ tenant: { ...tenant, modules } });
}));

// PATCH /api/superadmin/tenants/:id — infos, plan, statut, abonnement
router.patch('/tenants/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {};
  const sets = []; const vals = [id];
  const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) add('name', v.str(b.name, { max: 120, field: 'nom' }));
  if (b.city !== undefined) add('city', v.optStr(b.city, { max: 80, field: 'ville' }));
  if (b.phone !== undefined) add('phone', v.optStr(b.phone, { max: 40, field: 'téléphone' }));
  if (b.email !== undefined) add('email', b.email ? v.email(b.email) : null);
  if (b.plan !== undefined) add('plan', v.str(b.plan, { max: 40, field: 'plan' }));
  if (b.status !== undefined) add('status', v.oneOf(b.status, ['active', 'suspended', 'expired'], 'statut'));
  if (b.subscriptionEnd !== undefined) add('subscription_end', v.date(b.subscriptionEnd, 'fin abonnement'));
  const tz = b.timezone !== undefined ? tzOrFail(b.timezone) : null; if (tz) add('timezone', tz);
  const maxSub = b.maxSubsites !== undefined ? v.int(b.maxSubsites, { min: 0, max: 100, field: 'sous-pharmacies autorisées' }) : null;
  if (maxSub !== null) add('max_subsites', maxSub);
  if (b.groupPatientAccess !== undefined) throw new AppError(400, 'L’accès de l’Admin du groupe aux dossiers patients est accordé uniquement par le gérant local de la sous-pharmacie');
  if (!sets.length) throw new AppError(400, 'Aucune modification');

  const t = await tx({ system: true }, async (c) => {
    if (tz) await tzKnownToDb(c, tz);
    if (maxSub !== null) {
      const cur = (await c.query('SELECT parent_id, (SELECT count(*)::int FROM tenants ch WHERE ch.parent_id = $1) AS n FROM tenants WHERE id = $1', [id])).rows[0];
      if (!cur) throw new AppError(404, 'Pharmacie introuvable');
      if (maxSub !== null && cur.parent_id) throw new AppError(400, 'Une sous-pharmacie ne peut pas avoir de sous-pharmacies');
      if (maxSub !== null && maxSub < cur.n) throw new AppError(409, `Ce groupe compte déjà ${cur.n} sous-pharmacie(s) : le quota ne peut pas être inférieur`);
    }
    const r = (await c.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0];
    if (!r) throw new AppError(404, 'Pharmacie introuvable');
    await sysAudit(c, req, 'tenant.updated', id, id, b);
    return r;
  });
  res.json({ tenant: t });
}));

// PUT /api/superadmin/tenants/:id/modules — activation progressive des modules
router.put('/tenants/:id/modules', wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const modules = v.stringArray(req.body?.modules, 'modules').filter((m) => m !== 'core');
  if (modules.some((m) => !MODULE_KEYS.includes(m))) throw new AppError(400, 'Module inconnu');
  await tx({ system: true }, async (c) => {
    if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount) throw new AppError(404, 'Pharmacie introuvable');
    const before = (await c.query('SELECT module_key FROM tenant_modules WHERE tenant_id = $1', [id])).rows.map((r) => r.module_key);
    await c.query('DELETE FROM tenant_modules WHERE tenant_id = $1 AND NOT (module_key = ANY($2::text[]))', [id, modules]);
    for (const m of modules) await c.query('INSERT INTO tenant_modules (tenant_id, module_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, m]);
    await sysAudit(c, req, 'tenant.modules_updated', id, id, { before, after: modules });
  });
  res.json({ modules });
}));

// POST /api/superadmin/tenants/:id/admin — création du premier Admin local
router.post('/tenants/:id/admin', wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const email = v.email(req.body?.email);
  const fullName = v.str(req.body?.fullName, { max: 120, field: 'nom complet' });
  const pwd = req.body?.password ? v.password(req.body.password) : tempPassword();
  const generated = !req.body?.password;
  const replace = req.body?.replace === true;

  const user = await tx({ system: true }, async (c) => {
    if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount) throw new AppError(404, 'Pharmacie introuvable');
    if ((await c.query('SELECT 1 FROM tenants WHERE id = $1 AND parent_id IS NOT NULL', [id])).rowCount) {
      throw new AppError(409, 'Une sous-pharmacie n’a pas d’Admin : elle est administrée par l’Admin du groupe (désignez-y un gérant local)');
    }
    const current = (await c.query(`SELECT id, email FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active`, [id])).rows[0];
    if (current && !replace) throw new AppError(409, 'Cette pharmacie possède déjà un Admin (réinitialisez son mot de passe, ou remplacez-le)');
    if (current) {
      // attribution à une autre personne : l'ancien compte est désactivé et ses sessions révoquées
      await c.query('UPDATE users SET is_active = false WHERE id = $1', [current.id]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [current.id]);
      await sysAudit(c, req, 'tenant.admin_replaced', id, current.id, { replacedEmail: current.email });
    }
    if ((await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rowCount) throw new AppError(409, 'Email déjà utilisé');
    const u = (await c.query(
      `INSERT INTO users (tenant_id, email, full_name, role, password_hash, must_change_password, created_by)
       VALUES ($1,$2,$3,'admin',$4,true,$5) RETURNING id, email, full_name, role`,
      [id, email, fullName, await bcrypt.hash(pwd, 12), req.user.id])).rows[0];
    await sysAudit(c, req, 'tenant.admin_created', id, u.id, { email });
    return u;
  });
  // Le mot de passe temporaire n'est renvoyé qu'une seule fois, à transmettre de façon sécurisée.
  res.status(201).json({ user, temporaryPassword: generated ? pwd : undefined, mustChangePassword: true });
}));

// POST /api/superadmin/tenants/:id/admin/reset-password
router.post('/tenants/:id/admin/reset-password', wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const pwd = tempPassword();
  await tx({ system: true }, async (c) => {
    const r = await c.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL
        WHERE tenant_id = $1 AND role = 'admin' AND is_active RETURNING id`, [id, await bcrypt.hash(pwd, 12)]);
    if (!r.rowCount) throw new AppError(404, 'Aucun Admin pour cette pharmacie');
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [r.rows[0].id]);
    await sysAudit(c, req, 'tenant.admin_password_reset', id, r.rows[0].id, {});
  });
  res.json({ temporaryPassword: pwd });
}));

// GET /api/superadmin/tenants/:id/admin — infos de l'admin local
router.get('/tenants/:id/admin', wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const u = await tx({ system: true }, async (c) => (await c.query(
    `SELECT id, email, full_name, is_active, last_login_at, totp_enabled FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active`, [id])).rows[0]);
  res.json({ admin: u || null });
}));

// GET /api/superadmin/audit — journal global (50 derniers)
router.get('/audit', wrap(async (req, res) => {
  const rows = await tx({ system: true }, async (c) => (await c.query(`
    SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.ip, a.created_at, u.email AS user_email, t.name AS tenant_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN tenants t ON t.id = a.tenant_id
     ORDER BY a.id DESC LIMIT 50`)).rows);
  res.json({ logs: rows });
}));

// POST /api/superadmin/reference/import — base d'interactions/classes GLOBALE, partagée par toutes les pharmacies
router.post('/reference/import', wrap(async (req, res) => {
  const b = req.body || {};
  let parsed; try { parsed = parseImportBody(b); } catch (e) { throw new AppError(400, e.message); }
  if (!parsed.rules.length && !parsed.classes.length) throw new AppError(400, 'Aucune ligne à importer');
  const out = await tx({ system: true }, async (c) => {
    const r = await importReference(c, { tenantId: null, source: v.str(b.source, { min: 3, max: 300, field: 'source' }), ...parsed });
    await audit(c, { userId: req.user.id, action: 'reference.global_imported', entity: 'reference', meta: { rules: r.rules, classes: r.classes, source: b.source }, ip: req.ip });
    return r;
  });
  res.json(out);
}));

module.exports = router;
