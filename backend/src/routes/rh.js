'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { findOverlap, absenceOn, shiftMinutes } = require('../lib/shifts');
const { summarize } = require('../lib/hours');
const { addDays } = require('../lib/reminders');
const { today } = require('../lib/stock');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
router.use((req, res, next) => (req.user.enabledModules.includes('rh') ? next() : next(new AppError(409, 'Le module RH n\'est pas activé', 'MODULE_DISABLED'))));
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const A = (req, action, entity, entityId, meta) => ({ tenantId: req.user.tenantId, userId: req.user.id, action, entity, entityId, meta, ip: req.ip });
function range(q, defFrom, defTo, maxDays) {
  const to = v.date(typeof q.to === 'string' ? q.to : '', 'fin') || defTo; const from = v.date(typeof q.from === 'string' ? q.from : '', 'début') || defFrom;
  if (from > to) throw new AppError(400, 'La date de début doit précéder la date de fin');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > maxDays) throw new AppError(400, `Période limitée à ${maxDays} jours`);
  return { from, to };
}
const hhmm = (t) => String(t).slice(0, 5);

router.get('/staff', requirePermission('rh:read'), wrap(async (req, res) => {
  const rows = await tx(ctx(req), async (c) => (await c.query('SELECT id, full_name, role FROM users WHERE is_active ORDER BY lower(full_name)')).rows);
  res.json({ staff: rows.map((r) => ({ id: r.id, name: r.full_name, role: r.role })) });
}));

/* ---------------- Planning ---------------- */
router.get('/shifts', requirePermission('rh:read'), wrap(async (req, res) => {
  const { from, to } = range(req.query, today(req.user.timezone), addDays(today(req.user.timezone), 6), 93);
  const out = await tx(ctx(req), async (c) => ({
    shifts: (await c.query(`SELECT s.id, s.user_id, u.full_name, s.shift_date, s.start_time, s.end_time, s.kind, s.note FROM staff_shifts s JOIN users u ON u.id = s.user_id WHERE s.shift_date BETWEEN $1::date AND $2::date ORDER BY s.shift_date, s.start_time`, [from, to])).rows,
    absences: (await c.query(`SELECT a.id, a.user_id, u.full_name, a.start_date, a.end_date, a.kind, a.note FROM staff_absences a JOIN users u ON u.id = a.user_id WHERE a.start_date <= $2::date AND a.end_date >= $1::date ORDER BY a.start_date`, [from, to])).rows,
  }));
  res.json({ period: { from, to }, shifts: out.shifts.map((s) => ({ id: s.id, userId: s.user_id, name: s.full_name, date: s.shift_date, start: hhmm(s.start_time), end: hhmm(s.end_time), kind: s.kind, note: s.note })),
    absences: out.absences.map((a) => ({ id: a.id, userId: a.user_id, name: a.full_name, startDate: a.start_date, endDate: a.end_date, kind: a.kind, note: a.note })) });
}));

router.post('/shifts', requirePermission('rh:write'), wrap(async (req, res) => {
  const b = req.body || {}; const userId = v.uuid(b.userId, 'employé'); const date = v.date(b.date, 'date'); if (!date) throw new AppError(400, 'Date requise');
  const start = v.time(b.start, 'début'); const end = v.time(b.end, 'fin'); if (start === end) throw new AppError(400, 'Début et fin identiques');
  const kind = b.kind === undefined ? 'normal' : v.oneOf(b.kind, ['normal', 'garde', 'astreinte'], 'type'); const note = v.optStr(b.note, { max: 200, field: 'note' });
  const id = await tx(ctx(req), async (c) => {
    if (!(await c.query('SELECT 1 FROM users WHERE id = $1 AND is_active', [userId])).rowCount) throw new AppError(404, 'Employé introuvable ou inactif');
    const abs = (await c.query('SELECT start_date, end_date, kind FROM staff_absences WHERE user_id = $1 AND start_date <= $2::date AND end_date >= $2::date', [userId, date])).rows;
    if (absenceOn(date, abs)) throw new AppError(409, 'Cet employé est absent à cette date', 'ABSENCE_CONFLICT');
    const near = (await c.query('SELECT shift_date, start_time, end_time FROM staff_shifts WHERE user_id = $1 AND shift_date BETWEEN $2::date AND $3::date', [userId, addDays(date, -1), addDays(date, 1)])).rows;
    const clash = findOverlap({ date, start, end }, near);
    if (clash) throw new AppError(409, `Chevauchement avec un créneau existant (${clash.shift_date} ${hhmm(clash.start_time)}–${hhmm(clash.end_time)})`, 'SHIFT_OVERLAP');
    const r = (await c.query('INSERT INTO staff_shifts (tenant_id, user_id, shift_date, start_time, end_time, kind, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [req.user.tenantId, userId, date, start, end, kind, note, req.user.id])).rows[0];
    await audit(c, A(req, 'shift.created', 'shift', r.id, { userId, date, start, end, kind }));
    return r.id;
  });
  res.status(201).json({ id });
}));
router.delete('/shifts/:id', requirePermission('rh:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => { if (!(await c.query('DELETE FROM staff_shifts WHERE id = $1', [id])).rowCount) throw new AppError(404, 'Créneau introuvable'); await audit(c, A(req, 'shift.deleted', 'shift', id, {})); });
  res.json({ ok: true });
}));

router.post('/absences', requirePermission('rh:write'), wrap(async (req, res) => {
  const b = req.body || {}; const userId = v.uuid(b.userId, 'employé'); const startDate = v.date(b.startDate, 'début'); const endDate = v.date(b.endDate, 'fin');
  if (!startDate || !endDate) throw new AppError(400, 'Dates requises'); if (endDate < startDate) throw new AppError(400, 'La fin doit suivre le début');
  const kind = v.oneOf(b.kind, ['conge', 'maladie', 'autre'], 'type'); const note = v.optStr(b.note, { max: 200, field: 'note' });
  const out = await tx(ctx(req), async (c) => {
    if (!(await c.query('SELECT 1 FROM users WHERE id = $1 AND is_active', [userId])).rowCount) throw new AppError(404, 'Employé introuvable ou inactif');
    const r = (await c.query('INSERT INTO staff_absences (tenant_id, user_id, start_date, end_date, kind, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [req.user.tenantId, userId, startDate, endDate, kind, note, req.user.id])).rows[0];
    const conflicts = (await c.query('SELECT id, shift_date, start_time, end_time, kind FROM staff_shifts WHERE user_id = $1 AND shift_date BETWEEN $2::date AND $3::date ORDER BY shift_date', [userId, startDate, endDate])).rows;   // avertissement, pas un blocage : le responsable décide
    await audit(c, A(req, 'absence.created', 'absence', r.id, { userId, startDate, endDate, kind, conflicts: conflicts.length }));
    return { id: r.id, conflictingShifts: conflicts.map((s) => ({ id: s.id, date: s.shift_date, start: hhmm(s.start_time), end: hhmm(s.end_time), kind: s.kind })) };
  });
  res.status(201).json(out);
}));
router.delete('/absences/:id', requirePermission('rh:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => { if (!(await c.query('DELETE FROM staff_absences WHERE id = $1', [id])).rowCount) throw new AppError(404, 'Absence introuvable'); await audit(c, A(req, 'absence.deleted', 'absence', id, {})); });
  res.json({ ok: true });
}));

/* ---------------- Pointage (chacun pointe pour soi : aucun droit RH requis) ---------------- */
/** Le pointage est personnel : l'Admin du groupe qui travaille dans une sous-pharmacie pointe dans SA pharmacie, jamais dans celle d'un autre. */
const notActing = (req, res, next) => (req.user.acting ? next(new AppError(403, 'Le pointage se fait dans votre propre pharmacie', 'CLOCK_ACTING')) : next());

router.get('/clock', notActing, wrap(async (req, res) => {
  const open = await tx(ctx(req), async (c) => (await c.query('SELECT id, clock_in FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [req.user.id])).rows[0]);
  res.json({ open: open ? { id: open.id, clockIn: open.clock_in } : null });
}));
router.post('/clock', notActing, wrap(async (req, res) => {
  const action = v.oneOf(req.body?.action, ['in', 'out'], 'action');
  const out = await tx(ctx(req), async (c) => {
    const open = (await c.query('SELECT id FROM time_entries WHERE user_id = $1 AND clock_out IS NULL FOR UPDATE', [req.user.id])).rows[0];
    if (action === 'in') {
      if (open) throw new AppError(409, 'Vous avez déjà pointé votre arrivée', 'ALREADY_CLOCKED_IN');
      const r = (await c.query('INSERT INTO time_entries (tenant_id, user_id) VALUES ($1,$2) RETURNING id, clock_in', [req.user.tenantId, req.user.id])).rows[0];
      return { id: r.id, clockIn: r.clock_in };
    }
    if (!open) throw new AppError(409, 'Aucun pointage d\'arrivée ouvert', 'NOT_CLOCKED_IN');
    const r = (await c.query('UPDATE time_entries SET clock_out = GREATEST(now(), clock_in + interval \'1 second\') WHERE id = $1 RETURNING id, clock_in, clock_out', [open.id])).rows[0];
    return { id: r.id, clockIn: r.clock_in, clockOut: r.clock_out };
  });
  res.json(out);
}));

router.get('/time-entries', requirePermission('rh:read'), wrap(async (req, res) => {
  const { from, to } = range(req.query, addDays(today(req.user.timezone), -29), today(req.user.timezone), 366); const userId = req.query.userId ? v.uuid(req.query.userId, 'employé') : null;
  const rows = await tx(ctx(req), async (c) => (await c.query(`SELECT t.id, t.user_id, u.full_name, t.clock_in, t.clock_out FROM time_entries t JOIN users u ON u.id = t.user_id WHERE app_date(t.clock_in) BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR t.user_id = $3) ORDER BY t.clock_in DESC LIMIT 500`, [from, to, userId])).rows);
  res.json({ entries: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.full_name, clockIn: r.clock_in, clockOut: r.clock_out })) });
}));
// Correction par un responsable (oubli de pointage) : motif obligatoire, valeurs avant/après dans l'audit
router.patch('/time-entries/:id', requirePermission('rh:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {}; const reason = v.str(b.reason, { min: 3, max: 200, field: 'motif' });
  const ts = (x, f) => { const t = Date.parse(x); if (typeof x !== 'string' || Number.isNaN(t)) throw new AppError(400, `${f} invalide (date et heure)`); return new Date(t).toISOString(); };
  const cin = ts(b.clockIn, 'arrivée'); const cout = b.clockOut === null || b.clockOut === undefined ? null : ts(b.clockOut, 'départ');
  if (cout && Date.parse(cout) <= Date.parse(cin)) throw new AppError(400, 'Le départ doit suivre l\'arrivée');
  if (Date.parse(cin) > Date.now() + 60000 || (cout && Date.parse(cout) > Date.now() + 60000)) throw new AppError(400, 'Pointage dans le futur');
  await tx(ctx(req), async (c) => {
    const before = (await c.query('SELECT clock_in, clock_out FROM time_entries WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw new AppError(404, 'Pointage introuvable');
    await c.query('UPDATE time_entries SET clock_in = $2, clock_out = $3 WHERE id = $1', [id, cin, cout]);
    await audit(c, A(req, 'time_entry.corrected', 'time_entry', id, { reason, before, after: { clock_in: cin, clock_out: cout } }));
  });
  res.json({ ok: true });
}));

router.get('/hours', requirePermission('rh:read'), wrap(async (req, res) => {
  const { from, to } = range(req.query, addDays(today(req.user.timezone), -29), today(req.user.timezone), 366);
  const out = await tx(ctx(req), async (c) => ({
    staff: (await c.query('SELECT id, full_name FROM users WHERE is_active ORDER BY lower(full_name)')).rows,
    entries: (await c.query('SELECT user_id, clock_in, clock_out FROM time_entries WHERE clock_in::date BETWEEN $1::date AND $2::date', [from, to])).rows,
    shifts: (await c.query('SELECT user_id, shift_date, start_time, end_time FROM staff_shifts WHERE shift_date BETWEEN $1::date AND $2::date', [from, to])).rows,
  }));
  const worked = new Map(summarize(out.entries.map((e) => ({ userId: e.user_id, clockIn: e.clock_in.toISOString(), clockOut: e.clock_out ? e.clock_out.toISOString() : null }))).map((s) => [s.userId, s]));
  const planned = new Map(); for (const s of out.shifts) planned.set(s.user_id, (planned.get(s.user_id) || 0) + shiftMinutes(s.shift_date, s.start_time, s.end_time));
  res.json({ period: { from, to }, hours: out.staff.map((u) => ({ userId: u.id, name: u.full_name, workedHours: worked.get(u.id)?.hours || 0, plannedHours: Math.round(((planned.get(u.id) || 0) / 60) * 100) / 100, openEntries: worked.get(u.id)?.openEntries || 0 })) });
}));

module.exports = router;
