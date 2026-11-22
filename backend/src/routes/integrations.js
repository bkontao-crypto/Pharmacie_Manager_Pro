'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { norm } = require('../lib/text');
const { SEVERITY } = require('../lib/clinical');
const { normalizeRule, normalizeClass, importReference, parseImportBody } = require('../lib/reference');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const like = (q) => `%${norm(q).replace(/[%_\\]/g, '\\$&')}%`;
const scope = (r) => (r.tenant_id ? 'pharmacie' : 'globale');

// État de la base de référence : indispensable pour savoir ce qui est réellement contrôlé
router.get('/status', requirePermission('integrations:read'), wrap(async (req, res) => {
  const out = await tx(ctx(req), async (c) => {
    const rules = (await c.query('SELECT (tenant_id IS NULL) AS global, count(*)::int AS n FROM drug_interactions GROUP BY 1')).rows;
    const classes = (await c.query('SELECT (tenant_id IS NULL) AS global, count(*)::int AS n FROM substance_classes GROUP BY 1')).rows;
    const sources = (await c.query('SELECT DISTINCT source FROM drug_interactions UNION SELECT DISTINCT source FROM substance_classes ORDER BY 1 LIMIT 20')).rows.map((r) => r.source);
    const n = (arr, g) => arr.find((r) => r.global === g)?.n || 0;
    const noDci = (await c.query(`SELECT count(*)::int AS n FROM products WHERE is_active AND (dci IS NULL OR btrim(dci) = '')`)).rows[0].n;
    return { rules: { global: n(rules, true), pharmacy: n(rules, false) }, classes: { global: n(classes, true), pharmacy: n(classes, false) }, sources, productsWithoutDci: noDci };
  });
  res.json(out);
}));

router.get('/interactions', requirePermission('integrations:read'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT id, tenant_id, term_a, term_b, severity, description, recommendation, source FROM drug_interactions
      WHERE ($1 = '' OR term_a ILIKE $2 OR term_b ILIKE $2) ORDER BY term_a, term_b LIMIT 200`, [q, like(q)])).rows);
  res.json({ rules: rows.map((r) => ({ id: r.id, scope: scope(r), termA: r.term_a, termB: r.term_b, severity: r.severity, severityLabel: SEVERITY[r.severity].label, description: r.description, recommendation: r.recommendation, source: r.source })) });
}));

router.post('/interactions', requirePermission('integrations:write'), wrap(async (req, res) => {
  const r = normalizeRule(req.body || {}); if (!r.ok) throw new AppError(400, r.error);
  const x = r.value;
  const id = await tx(ctx(req), async (c) => {
    const row = (await c.query(`INSERT INTO drug_interactions (tenant_id, term_a, term_b, severity, description, recommendation, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,'pharmacie',$7) RETURNING id`,
      [req.user.tenantId, x.term_a, x.term_b, x.severity, x.description, x.recommendation, req.user.id])).rows[0];
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'reference.rule_created', entity: 'interaction', entityId: row.id, meta: { a: x.term_a, b: x.term_b, severity: x.severity }, ip: req.ip });
    return row.id;
  });
  res.status(201).json({ id });
}));

router.delete('/interactions/:id', requirePermission('integrations:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const r = await c.query('DELETE FROM drug_interactions WHERE id = $1 AND tenant_id = $2', [id, req.user.tenantId]); // les règles globales ne sont pas supprimables ici
    if (!r.rowCount) throw new AppError(404, 'Règle introuvable (les règles globales ne se suppriment pas ici)');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'reference.rule_deleted', entity: 'interaction', entityId: id, ip: req.ip });
  });
  res.json({ ok: true });
}));

router.get('/classes', requirePermission('integrations:read'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const rows = await tx(ctx(req), async (c) => (await c.query(`SELECT id, tenant_id, substance, class, source FROM substance_classes WHERE ($1 = '' OR substance ILIKE $2 OR class ILIKE $2) ORDER BY class, substance LIMIT 300`, [q, like(q)])).rows);
  res.json({ classes: rows.map((r) => ({ id: r.id, scope: scope(r), substance: r.substance, class: r.class, source: r.source })) });
}));
router.post('/classes', requirePermission('integrations:write'), wrap(async (req, res) => {
  const r = normalizeClass(req.body || {}); if (!r.ok) throw new AppError(400, r.error);
  await tx(ctx(req), async (c) => {
    await c.query(`INSERT INTO substance_classes (tenant_id, substance, class, source) VALUES ($1,$2,$3,'pharmacie')`, [req.user.tenantId, r.value.substance, r.value.class]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'reference.class_created', entity: 'class', meta: r.value, ip: req.ip });
  });
  res.status(201).json({ ok: true });
}));
router.delete('/classes/:id', requirePermission('integrations:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const r = await c.query('DELETE FROM substance_classes WHERE id = $1 AND tenant_id = $2', [id, req.user.tenantId]);
    if (!r.rowCount) throw new AppError(404, 'Classe introuvable (les classes globales ne se suppriment pas ici)');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'reference.class_deleted', entity: 'class', entityId: id, ip: req.ip });
  });
  res.json({ ok: true });
}));

// Import JSON ou CSV (règles ou classes) propre à la pharmacie
router.post('/import', requirePermission('integrations:write'), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.format === 'csv' && (typeof b.content !== 'string' || b.content.length > 2_000_000)) throw new AppError(400, 'Contenu CSV requis (2 Mo max)');
  let parsed; try { parsed = parseImportBody(b); } catch (e) { throw new AppError(400, e.message); }
  if (!parsed.rules.length && !parsed.classes.length) throw new AppError(400, 'Aucune ligne à importer');
  const out = await tx(ctx(req), async (c) => {
    const r = await importReference(c, { tenantId: req.user.tenantId, source: v.optStr(b.source, { max: 200, field: 'source' }) || 'import pharmacie', ...parsed });
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'reference.imported', entity: 'reference', meta: { rules: r.rules, classes: r.classes, errors: r.errors.length }, ip: req.ip });
    return r;
  });
  res.json(out);
}));

module.exports = router;
