'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { encrypt, decrypt } = require('../lib/crypto');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const { localDate } = require('../lib/tz');
const router = express.Router();
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
router.use(authenticate, blockIfMustChange, requireTenantUser);

const LIST_COLS = 'id, last_name, first_name, birth_date, sex, phone, allergies, is_active';
const toApi = (r) => ({
  id: r.id, lastName: r.last_name, firstName: r.first_name, birthDate: r.birth_date, sex: r.sex, phone: r.phone, address: r.address,
  insuranceProvider: r.insurance_provider, insuranceNumber: r.insurance_number_enc ? decrypt(r.insurance_number_enc) : null,
  allergies: r.allergies, contraindications: r.contraindications, notes: r.notes_enc ? decrypt(r.notes_enc) : null,
  isActive: r.is_active, createdAt: r.created_at,
});

function parse(b, partial = false, tz = 'UTC') {
  const o = {}; const has = (k) => b[k] !== undefined;
  if (!partial || has('lastName')) o.last_name = v.str(b.lastName, { max: 80, field: 'nom' });
  if (!partial || has('firstName')) o.first_name = v.str(b.firstName, { max: 80, field: 'prénom' });
  if (has('birthDate')) { o.birth_date = v.date(b.birthDate, 'date de naissance'); if (o.birth_date && o.birth_date > localDate(new Date(), tz)) throw new AppError(400, 'Date de naissance dans le futur'); }
  if (has('sex')) o.sex = b.sex ? v.oneOf(b.sex, ['F', 'M'], 'sexe') : null;
  if (has('phone')) o.phone = v.optStr(b.phone, { max: 40, field: 'téléphone' });
  if (has('address')) o.address = v.optStr(b.address, { max: 200, field: 'adresse' });
  if (has('insuranceProvider')) o.insurance_provider = v.optStr(b.insuranceProvider, { max: 120, field: 'organisme' });
  if (has('insuranceNumber')) { const n = v.optStr(b.insuranceNumber, { max: 60, field: 'n° assuré' }); o.insurance_number_enc = n ? encrypt(n) : null; }
  if (has('allergies')) o.allergies = v.stringArray(b.allergies, 'allergies').map((a) => v.str(a, { max: 80, field: 'allergie' })).slice(0, 50);
  if (has('contraindications')) o.contraindications = v.optStr(b.contraindications, { max: 1000, field: 'contre-indications' });
  if (has('notes')) { const n = v.optStr(b.notes, { max: 4000, field: 'notes' }); o.notes_enc = n ? encrypt(n) : null; }
  return o;
}

// GET /api/patients?q=&includeInactive=1
router.get('/', requirePermission('patients:read'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT ${LIST_COLS} FROM patients
      WHERE ($3 OR is_active) AND ($1 = '' OR last_name ILIKE $2 OR first_name ILIKE $2 OR phone ILIKE $2)
      ORDER BY lower(last_name), lower(first_name) LIMIT 100`, [q, like, req.query.includeInactive === '1'])).rows);
  res.json({ patients: rows.map((r) => ({ id: r.id, lastName: r.last_name, firstName: r.first_name, birthDate: r.birth_date, sex: r.sex, phone: r.phone, allergies: r.allergies, isActive: r.is_active })) });
}));

// POST /api/patients
router.post('/', requirePermission('patients:write'), wrap(async (req, res) => {
  const o = parse(req.body || {}, false, req.user.timezone);
  const cols = Object.keys(o);
  const row = await tx(ctx(req), async (c) => {
    const r = (await c.query(
      `INSERT INTO patients (tenant_id, created_by, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
      [req.user.tenantId, req.user.id, ...cols.map((k) => o[k])])).rows[0];
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'patient.created', entity: 'patient', entityId: r.id, ip: req.ip });
    return r;
  });
  res.status(201).json({ patient: toApi(row) });
}));

// GET /api/patients/:id — l'accès à un dossier est tracé (données de santé)
router.get('/:id', requirePermission('patients:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const p = (await c.query('SELECT * FROM patients WHERE id = $1', [id])).rows[0];
    if (!p) throw new AppError(404, 'Patient introuvable');
    const history = (await c.query(
      `SELECT r.id, r.number, r.prescribed_on, r.prescriber_name, r.status, r.dispensed_at,
              COALESCE(json_agg(json_build_object('product', pr.name, 'quantity', i.quantity, 'posology', i.posology)) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM prescriptions r LEFT JOIN prescription_items i ON i.prescription_id = r.id LEFT JOIN products pr ON pr.id = i.product_id
        WHERE r.patient_id = $1 GROUP BY r.id ORDER BY r.created_at DESC LIMIT 50`, [id])).rows;
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'patient.viewed', entity: 'patient', entityId: id, ip: req.ip });
    return { patient: toApi(p), history };
  });
  res.json(out);
}));

// PATCH /api/patients/:id
router.patch('/:id', requirePermission('patients:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const o = parse(req.body || {}, true, req.user.timezone);
  const cols = Object.keys(o);
  if (!cols.length) throw new AppError(400, 'Aucune modification');
  const row = await tx(ctx(req), async (c) => {
    const r = (await c.query(`UPDATE patients SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => o[k])])).rows[0];
    if (!r) throw new AppError(404, 'Patient introuvable');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'patient.updated', entity: 'patient', entityId: id, meta: { fields: cols }, ip: req.ip });
    return r;
  });
  res.json({ patient: toApi(row) });
}));

// DELETE /api/patients/:id — archivage (jamais de suppression physique : traçabilité des délivrances)
router.delete('/:id', requirePermission('patients:delete'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const r = await c.query('UPDATE patients SET is_active = false, updated_at = now() WHERE id = $1', [id]);
    if (!r.rowCount) throw new AppError(404, 'Patient introuvable');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'patient.archived', entity: 'patient', entityId: id, ip: req.ip });
  });
  res.json({ ok: true });
}));

module.exports = router;
