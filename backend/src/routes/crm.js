'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { encrypt, decrypt } = require('../lib/crypto');
const { today } = require('../lib/stock');
const { computeDue, diffDays, addDays } = require('../lib/reminders');
const { loyaltyBalance, loyaltySettings, addLedger } = require('../lib/loyaltyDb');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
router.use((req, res, next) => (req.user.enabledModules.includes('patients') ? next() : next(new AppError(409, 'Le CRM nécessite le module Patients', 'MODULE_DEPENDENCY'))));
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const A = (req, action, entity, entityId, meta) => ({ tenantId: req.user.tenantId, userId: req.user.id, action, entity, entityId, meta, ip: req.ip });

/* ---------------- Paramètres (fidélité, anticipation des rappels) ---------------- */
const toSettings = (r) => ({ loyaltyEnabled: r.loyalty_enabled, loyaltyEarnAmount: Number(r.loyalty_earn_amount), loyaltyPointValue: Number(r.loyalty_point_value), reminderLeadDays: r.reminder_lead_days });
router.get('/settings', requirePermission('crm:read'), wrap(async (req, res) => {
  const r = await tx(ctx(req), async (c) => { await c.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.tenantId]); return (await c.query('SELECT * FROM tenant_settings WHERE tenant_id = $1', [req.user.tenantId])).rows[0]; });
  res.json({ settings: toSettings(r) });
}));
router.put('/settings', requirePermission('crm:write'), wrap(async (req, res) => {
  const b = req.body || {}; const sets = []; const vals = [req.user.tenantId]; const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (b.loyaltyEnabled !== undefined) add('loyalty_enabled', v.bool(b.loyaltyEnabled, 'fidélité activée'));
  if (b.loyaltyEarnAmount !== undefined) { const m = v.money(b.loyaltyEarnAmount, 'montant par point'); if (m <= 0) throw new AppError(400, 'Montant par point : supérieur à 0'); add('loyalty_earn_amount', m); }
  if (b.loyaltyPointValue !== undefined) { const m = v.money(b.loyaltyPointValue, 'valeur du point'); if (m <= 0) throw new AppError(400, 'Valeur du point : supérieure à 0'); add('loyalty_point_value', m); }
  if (b.reminderLeadDays !== undefined) add('reminder_lead_days', v.int(b.reminderLeadDays, { min: 0, max: 30, field: 'anticipation des rappels (jours)' }));
  if (!sets.length) throw new AppError(400, 'Aucune modification');
  const r = await tx(ctx(req), async (c) => {
    await c.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.tenantId]);
    const row = (await c.query(`UPDATE tenant_settings SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 RETURNING *`, vals)).rows[0];
    await audit(c, A(req, 'crm.settings_updated', 'settings', req.user.tenantId, b));
    return row;
  });
  res.json({ settings: toSettings(r) });
}));

/* ---------------- Fidélité ---------------- */
router.get('/loyalty/:patientId', requirePermission('crm:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.patientId, 'patient');
  const out = await tx(ctx(req), async (c) => {
    const p = (await c.query('SELECT last_name, first_name FROM patients WHERE id = $1', [id])).rows[0];
    if (!p) throw new AppError(404, 'Patient introuvable');
    const entries = (await c.query('SELECT points, reason, created_at FROM loyalty_ledger WHERE patient_id = $1 ORDER BY id DESC LIMIT 50', [id])).rows;
    return { patient: `${p.last_name} ${p.first_name}`, balance: await loyaltyBalance(c, id), entries: entries.map((e) => ({ points: e.points, reason: e.reason, date: e.created_at })) };
  });
  res.json(out);
}));
// Correction manuelle : jamais de modification du registre, on ajoute une ligne (motif obligatoire, tracée)
router.post('/loyalty/:patientId/adjust', requirePermission('crm:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.patientId, 'patient'); const points = v.int(req.body?.points, { min: -100000, max: 100000, field: 'points' });
  if (points === 0) throw new AppError(400, 'Points : valeur non nulle requise');
  const reason = v.str(req.body?.reason, { min: 3, max: 200, field: 'motif' });
  const balance = await tx(ctx(req), async (c) => {
    if (!(await c.query('SELECT 1 FROM patients WHERE id = $1 FOR UPDATE', [id])).rowCount) throw new AppError(404, 'Patient introuvable');
    const b = await loyaltyBalance(c, id);
    if (b + points < 0) throw new AppError(409, `Le solde ne peut pas devenir négatif (solde actuel : ${b})`);
    await addLedger(c, { tenantId: req.user.tenantId, patientId: id, points, reason: `Ajustement manuel : ${reason}`, userId: req.user.id });
    await audit(c, A(req, 'loyalty.adjusted', 'patient', id, { points, reason }));
    return b + points;
  });
  res.json({ balance });
}));

/* ---------------- Rappels de renouvellement ---------------- */
router.post('/reminders/generate', requirePermission('crm:write'), wrap(async (req, res) => {
  const out = await tx(ctx(req), async (c) => {
    const cfg = await loyaltySettings(c, req.user.tenantId);
    // 1) un rappel ouvert est clos si le patient est revenu (nouvelle délivrance du produit après la dernière connue)
    const closed = (await c.query(
      `UPDATE patient_reminders pr SET status = 'done', note = COALESCE(note || ' · ', '') || 'renouvelé', updated_by = $1
        WHERE pr.status IN ('pending','contacted') AND EXISTS (
          SELECT 1 FROM prescriptions r JOIN prescription_items i ON i.prescription_id = r.id
           WHERE r.patient_id = pr.patient_id AND i.product_id = pr.product_id AND r.status = 'dispensed' AND app_date(r.dispensed_at) > pr.last_on)`, [req.user.id])).rowCount;
    // 2) dernière délivrance par (patient, produit) pour les produits ayant un cycle de renouvellement
    const rows = (await c.query(
      `SELECT r.patient_id, i.product_id, to_char(MAX(app_date(r.dispensed_at)), 'YYYY-MM-DD') AS last_on, p.renewal_days
         FROM prescriptions r JOIN prescription_items i ON i.prescription_id = r.id JOIN products p ON p.id = i.product_id JOIN patients pa ON pa.id = r.patient_id AND pa.is_active
        WHERE r.status = 'dispensed' AND p.is_active AND p.renewal_days IS NOT NULL GROUP BY r.patient_id, i.product_id, p.renewal_days`)).rows;
    const due = computeDue(rows.map((r) => ({ patientId: r.patient_id, productId: r.product_id, lastOn: r.last_on, renewalDays: r.renewal_days })), today(req.user.timezone), cfg.reminderLeadDays);
    let created = 0;
    for (const d of due) created += (await c.query(
      `INSERT INTO patient_reminders (tenant_id, patient_id, product_id, last_on, due_on) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, patient_id, product_id, due_on) DO NOTHING`,
      [req.user.tenantId, d.patientId, d.productId, d.lastOn, d.dueOn])).rowCount;
    await audit(c, A(req, 'reminders.generated', 'reminder', null, { created, closed }));
    return { created, closed, due: due.length };
  });
  res.json(out);
}));

router.get('/reminders', requirePermission('crm:read'), wrap(async (req, res) => {
  const st = ['pending', 'contacted', 'done', 'dismissed'].includes(req.query.status) ? req.query.status : null;   // défaut : ouverts (à faire + contactés)
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT pr.id, pr.status, pr.note, pr.last_on, pr.due_on, pr.contacted_at, pa.id AS patient_id, pa.last_name, pa.first_name, pa.phone, p.name AS product_name
       FROM patient_reminders pr JOIN patients pa ON pa.id = pr.patient_id JOIN products p ON p.id = pr.product_id
      WHERE ($1::text IS NULL AND pr.status IN ('pending','contacted')) OR pr.status = $1 ORDER BY pr.due_on, pa.last_name LIMIT 300`, [st])).rows);
  const day = today(req.user.timezone);
  res.json({ reminders: rows.map((r) => ({ id: r.id, status: r.status, note: r.note, lastOn: r.last_on, dueOn: r.due_on, daysLate: diffDays(day, r.due_on), contactedAt: r.contacted_at, patientId: r.patient_id, patientName: `${r.last_name} ${r.first_name}`, phone: r.phone, productName: r.product_name })) });
}));
router.patch('/reminders/:id', requirePermission('crm:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const status = v.oneOf(req.body?.status, ['pending', 'contacted', 'done', 'dismissed'], 'statut'); const note = v.optStr(req.body?.note, { max: 300, field: 'note' });
  await tx(ctx(req), async (c) => {
    const r = await c.query(`UPDATE patient_reminders SET status = $2, note = COALESCE($3, note), contacted_at = CASE WHEN $2 = 'contacted' THEN now() ELSE contacted_at END, updated_by = $4 WHERE id = $1`, [id, status, note, req.user.id]);
    if (!r.rowCount) throw new AppError(404, 'Rappel introuvable');
    await audit(c, A(req, 'reminder.updated', 'reminder', id, { status }));
  });
  res.json({ ok: true });
}));

/* ---------------- Entretiens pharmaceutiques (contenu chiffré) ---------------- */
const KINDS = ['bilan_medication', 'asthme', 'anticoagulants', 'diabete', 'autre'];
const toInterview = (r) => ({ id: r.id, patientId: r.patient_id, patientName: r.patient_name, interviewOn: r.interview_on, kind: r.kind, followUpOn: r.follow_up_on, followUpDone: r.follow_up_done, pharmacist: r.pharmacist_name });
const IV_SQL = `SELECT i.*, pa.last_name || ' ' || pa.first_name AS patient_name, u.full_name AS pharmacist_name FROM pharma_interviews i JOIN patients pa ON pa.id = i.patient_id LEFT JOIN users u ON u.id = i.pharmacist_id`;

router.get('/interviews', requirePermission('crm:read'), wrap(async (req, res) => {
  const patientId = req.query.patientId ? v.uuid(req.query.patientId, 'patient') : null; const followUps = req.query.followUps === '1';
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `${IV_SQL} WHERE ($1::uuid IS NULL OR i.patient_id = $1) AND (NOT $2 OR (i.follow_up_on IS NOT NULL AND NOT i.follow_up_done AND i.follow_up_on <= $3::date))
      ORDER BY CASE WHEN $2 THEN i.follow_up_on END, i.interview_on DESC LIMIT 200`, [patientId, followUps, addDays(today(req.user.timezone), 14)])).rows);
  res.json({ interviews: rows.map(toInterview) });                                       // la liste ne contient jamais le contenu des entretiens
}));
router.get('/interviews/:id', requirePermission('crm:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const r = (await c.query(`${IV_SQL} WHERE i.id = $1`, [id])).rows[0];
    if (!r) throw new AppError(404, 'Entretien introuvable');
    await audit(c, A(req, 'interview.viewed', 'interview', id, {}));
    return { interview: { ...toInterview(r), summary: decrypt(r.summary_enc), actions: r.actions_enc ? decrypt(r.actions_enc) : null } };
  });
  res.json(out);
}));
router.post('/interviews', requirePermission('crm:write'), wrap(async (req, res) => {
  const b = req.body || {}; const patientId = v.uuid(b.patientId, 'patient'); const kind = v.oneOf(b.kind, KINDS, 'type d\'entretien');
  const on = v.date(b.interviewOn, 'date'); if (!on) throw new AppError(400, 'Date requise'); if (on > today(req.user.timezone)) throw new AppError(400, 'Date dans le futur');
  const summary = v.str(b.summary, { min: 3, max: 4000, field: 'compte rendu' }); const actions = v.optStr(b.actions, { max: 4000, field: 'actions' }); const fu = v.date(b.followUpOn, 'suivi');
  if (fu && fu < on) throw new AppError(400, 'Le suivi doit être postérieur à l\'entretien');
  const id = await tx(ctx(req), async (c) => {
    if (!(await c.query('SELECT 1 FROM patients WHERE id = $1 AND is_active', [patientId])).rowCount) throw new AppError(404, 'Patient introuvable ou archivé');
    const r = (await c.query(`INSERT INTO pharma_interviews (tenant_id, patient_id, interview_on, kind, summary_enc, actions_enc, follow_up_on, pharmacist_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.tenantId, patientId, on, kind, encrypt(summary), actions ? encrypt(actions) : null, fu, req.user.id])).rows[0];
    await audit(c, A(req, 'interview.created', 'interview', r.id, { kind, patientId }));
    return r.id;
  });
  res.status(201).json({ id });
}));
router.patch('/interviews/:id', requirePermission('crm:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {}; const sets = []; const vals = [id]; const add = (c, x) => { vals.push(x); sets.push(`${c} = $${vals.length}`); };
  if (b.followUpDone !== undefined) add('follow_up_done', v.bool(b.followUpDone, 'suivi effectué'));
  if (b.followUpOn !== undefined) add('follow_up_on', v.date(b.followUpOn, 'suivi'));
  if (b.actions !== undefined) { const a = v.optStr(b.actions, { max: 4000, field: 'actions' }); add('actions_enc', a ? encrypt(a) : null); }
  if (!sets.length) throw new AppError(400, 'Aucune modification');
  await tx(ctx(req), async (c) => {
    if (!(await c.query(`UPDATE pharma_interviews SET ${sets.join(', ')} WHERE id = $1`, vals)).rowCount) throw new AppError(404, 'Entretien introuvable');
    await audit(c, A(req, 'interview.updated', 'interview', id, { fields: Object.keys(b) }));
  });
  res.json({ ok: true });
}));

module.exports = router;
