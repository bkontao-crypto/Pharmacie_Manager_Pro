'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { today } = require('../lib/stock');
const { consumeFEFO } = require('./../lib/stockOps');
const { computeAlerts } = require('../lib/reference');
const { isEquivalent } = require('../lib/substitution');
const { substancesOf } = require('../lib/substances');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
// La dispensation s'appuie sur les dossiers patients et sur le stock : les deux modules doivent être activés.
router.use((req, res, next) => (['patients', 'stocks'].every((m) => req.user.enabledModules.includes(m))
  ? next() : next(new AppError(409, 'La dispensation nécessite les modules Patients et Stocks', 'MODULE_DEPENDENCY'))));
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });

const ITEMS_SQL = `
  SELECT i.id, i.product_id, i.quantity, i.posology, p.name, p.dci, p.form, p.dosage, p.is_generic, o.name AS substituted_from_name,
         COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.product_id = p.id AND l.expiry_date >= app_today()), 0)::int AS available
    FROM prescription_items i JOIN products p ON p.id = i.product_id LEFT JOIN products o ON o.id = i.substituted_from WHERE i.prescription_id = $1 ORDER BY i.id`;
const num = (n) => `ORD-${String(n).padStart(6, '0')}`;
const toRx = (r) => ({
  id: r.id, number: num(r.number), patientId: r.patient_id, patientName: r.patient_name, prescriberName: r.prescriber_name,
  prescribedOn: r.prescribed_on, status: r.status, notes: r.notes, alerts: r.alerts, alertsAcknowledged: r.alerts_acknowledged,
  createdAt: r.created_at, validatedAt: r.validated_at, dispensedAt: r.dispensed_at, cancelledReason: r.cancelled_reason,
});
const RX_SQL = `SELECT r.*, p.last_name || ' ' || p.first_name AS patient_name FROM prescriptions r JOIN patients p ON p.id = r.patient_id`;

// ---- Recherches minimales pour le formulaire (évite d'exiger patients:read / stocks:read) ----
router.get('/lookup/patients', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT id, last_name, first_name, birth_date, allergies FROM patients WHERE is_active AND ($1 = '' OR last_name ILIKE $2 OR first_name ILIKE $2 OR phone ILIKE $2) ORDER BY lower(last_name) LIMIT 20`, [q, like])).rows);
  res.json({ patients: rows.map((r) => ({ id: r.id, name: `${r.last_name} ${r.first_name}`, birthDate: r.birth_date, allergies: r.allergies })) });
}));
router.get('/lookup/products', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT p.id, p.name, p.dci, p.form, p.dosage,
            COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.product_id = p.id AND l.expiry_date >= app_today()), 0)::int AS available
       FROM products p WHERE p.is_active AND ($1 = '' OR p.name ILIKE $2 OR p.dci ILIKE $2 OR p.barcode = $1) ORDER BY lower(p.name) LIMIT 20`, [q, like])).rows);
  res.json({ products: rows });
}));

// GET /api/dispensation/prescriptions?status=
router.get('/prescriptions', requirePermission('dispensation:read'), wrap(async (req, res) => {
  const status = ['pending', 'validated', 'dispensed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = await tx(ctx(req), async (c) => (await c.query(`${RX_SQL} WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 100`, [status])).rows);
  res.json({ prescriptions: rows.map(toRx) });
}));

// GET /api/dispensation/prescriptions/:id
router.get('/prescriptions/:id', requirePermission('dispensation:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const r = (await c.query(`${RX_SQL} WHERE r.id = $1`, [id])).rows[0];
    if (!r) throw new AppError(404, 'Ordonnance introuvable');
    return { prescription: toRx(r), items: (await c.query(ITEMS_SQL, [id])).rows };
  });
  res.json(out);
}));

// POST /api/dispensation/prescriptions — saisie (statut « à valider »)
router.post('/prescriptions', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const b = req.body || {};
  const patientId = v.uuid(b.patientId, 'patient');
  const prescriber = v.str(b.prescriberName, { max: 120, field: 'prescripteur' });
  const on = v.date(b.prescribedOn, 'date de prescription'); if (!on) throw new AppError(400, 'Date de prescription requise');
  if (on > today(req.user.timezone)) throw new AppError(400, 'Date de prescription dans le futur');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 40) throw new AppError(400, 'Entre 1 et 40 lignes de produits requises');
  const items = b.items.map((it) => ({ productId: v.uuid(it?.productId, 'produit'), quantity: v.int(it?.quantity, { min: 1, max: 1000, field: 'quantité' }), posology: v.optStr(it?.posology, { max: 300, field: 'posologie' }) }));
  if (new Set(items.map((i) => i.productId)).size !== items.length) throw new AppError(400, 'Un produit apparaît plusieurs fois : regroupez les quantités');
  const notes = v.optStr(b.notes, { max: 1000, field: 'notes' });

  const out = await tx(ctx(req), async (c) => {
    const pat = (await c.query('SELECT id, allergies FROM patients WHERE id = $1 AND is_active', [patientId])).rows[0];
    if (!pat) throw new AppError(404, 'Patient introuvable ou archivé');
    const prods = (await c.query('SELECT id, name, dci FROM products WHERE id = ANY($1::uuid[]) AND is_active', [items.map((i) => i.productId)])).rows;
    if (prods.length !== items.length) throw new AppError(404, 'Produit introuvable ou inactif');
    const alerts = await computeAlerts(c, { patientId, allergies: pat.allergies, products: prods });
    const rx = (await c.query(
      `INSERT INTO prescriptions (tenant_id, patient_id, prescriber_name, prescribed_on, notes, alerts, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, number`,
      [req.user.tenantId, patientId, prescriber, on, notes, JSON.stringify(alerts), req.user.id])).rows[0];
    for (const it of items) await c.query('INSERT INTO prescription_items (tenant_id, prescription_id, product_id, quantity, posology) VALUES ($1,$2,$3,$4,$5)', [req.user.tenantId, rx.id, it.productId, it.quantity, it.posology]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'prescription.created', entity: 'prescription', entityId: rx.id, meta: { number: num(rx.number), items: items.length, alerts: alerts.length }, ip: req.ip });
    return { id: rx.id, number: num(rx.number), alerts };
  });
  res.status(201).json(out);
}));

// POST /api/dispensation/prescriptions/:id/validate — contrôle pharmacien (double contrôle)
router.post('/prescriptions/:id/validate', requirePermission('dispensation:validate'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const ack = req.body?.acknowledgeAlerts === true;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
  const out = await tx(ctx(req), async (c) => {
    const r = (await c.query('SELECT * FROM prescriptions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new AppError(404, 'Ordonnance introuvable');
    if (r.status !== 'pending') throw new AppError(409, 'Seule une ordonnance « à valider » peut être validée');
    // les alertes sont recalculées à la validation (dossier, base de référence ou substitution ont pu changer)
    const pat = (await c.query('SELECT allergies FROM patients WHERE id = $1', [r.patient_id])).rows[0];
    const prods = (await c.query('SELECT p.id, p.name, p.dci FROM prescription_items i JOIN products p ON p.id = i.product_id WHERE i.prescription_id = $1', [id])).rows;
    const alerts = await computeAlerts(c, { patientId: r.patient_id, allergies: pat.allergies, products: prods });
    const needsAck = alerts.some((a) => a.level !== 'info'); const needsNote = alerts.some((a) => a.level === 'danger');
    if (needsAck && !ack) throw Object.assign(new AppError(409, 'Alertes à examiner avant validation', 'ALERTS_REQUIRE_ACK'), { alerts, requiresNote: needsNote });
    if (needsNote && note.length < 5) throw Object.assign(new AppError(409, 'Une justification écrite (5 caractères minimum) est requise pour passer outre une alerte grave', 'NOTE_REQUIRED'), { alerts, requiresNote: true });
    await c.query(`UPDATE prescriptions SET status = 'validated', validated_by = $2, validated_at = now(), alerts = $3, alerts_acknowledged = $4, ack_note = $5 WHERE id = $1`, [id, req.user.id, JSON.stringify(alerts), needsAck, needsNote ? note : null]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'prescription.validated', entity: 'prescription', entityId: id, meta: { alerts: alerts.length, acknowledged: needsAck, justification: needsNote ? note : undefined }, ip: req.ip });
    return { ok: true };
  });
  res.json(out);
}));

// POST /api/dispensation/prescriptions/:id/dispense — sortie de stock FEFO, atomique
router.post('/prescriptions/:id/dispense', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const r = (await c.query('SELECT * FROM prescriptions WHERE id = $1 FOR UPDATE', [id])).rows[0]; // sérialise les délivrances concurrentes
    if (!r) throw new AppError(404, 'Ordonnance introuvable');
    if (r.status !== 'validated') throw new AppError(409, 'L\'ordonnance doit être validée par un pharmacien avant délivrance');
    const items = (await c.query('SELECT i.product_id, i.quantity, p.name FROM prescription_items i JOIN products p ON p.id = i.product_id WHERE i.prescription_id = $1 ORDER BY i.product_id', [id])).rows;
    let lotsUsed = 0;
    for (const it of items) { // ordre déterministe (product_id) → pas d'interblocage entre ordonnances ; tout est annulé si un produit manque
      const used = await consumeFEFO(c, { tenantId: req.user.tenantId, userId: req.user.id, productId: it.product_id, productName: it.name, quantity: it.quantity, type: 'dispensation', reason: `Délivrance ${num(r.number)}`, refId: id });
      lotsUsed += used.length;
    }
    await c.query(`UPDATE prescriptions SET status = 'dispensed', dispensed_by = $2, dispensed_at = now() WHERE id = $1`, [id, req.user.id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'prescription.dispensed', entity: 'prescription', entityId: id, meta: { number: num(r.number), lots: lotsUsed }, ip: req.ip });
    return { ok: true, movements: lotsUsed };
  });
  res.json(out);
}));

// POST /api/dispensation/prescriptions/:id/cancel
router.post('/prescriptions/:id/cancel', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const reason = v.str(req.body?.reason, { min: 3, max: 300, field: 'motif' });
  await tx(ctx(req), async (c) => {
    const r = (await c.query('SELECT status FROM prescriptions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new AppError(404, 'Ordonnance introuvable');
    if (!['pending', 'validated'].includes(r.status)) throw new AppError(409, 'Une ordonnance délivrée ou déjà annulée ne peut plus être annulée');
    await c.query(`UPDATE prescriptions SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`, [id, reason]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'prescription.cancelled', entity: 'prescription', entityId: id, meta: { reason }, ip: req.ip });
  });
  res.json({ ok: true });
}));

// ---- Substitutions génériques : mêmes substances, même dosage, même forme ----
router.get('/substitutes', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const id = v.uuid(req.query.productId, 'produit');
  const out = await tx(ctx(req), async (c) => {
    const orig = (await c.query('SELECT id, name, dci, dosage, form FROM products WHERE id = $1', [id])).rows[0];
    if (!orig) throw new AppError(404, 'Produit introuvable');
    if (!substancesOf(orig.dci).length) return { product: { id: orig.id, name: orig.name }, substitutes: [], reason: 'DCI non renseignée : aucun substitut ne peut être proposé' };
    const cands = (await c.query(
      `SELECT p.id, p.name, p.dci, p.dosage, p.form, p.sale_price, p.is_generic,
              COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.product_id = p.id AND l.expiry_date >= app_today()), 0)::int AS available
         FROM products p WHERE p.is_active AND p.id <> $1 AND p.dci IS NOT NULL AND btrim(p.dci) <> '' LIMIT 20000`, [id])).rows;
    const subs = cands.filter((p) => isEquivalent(orig, p)).sort((a, b) => (b.available > 0) - (a.available > 0) || Number(a.sale_price) - Number(b.sale_price));
    return { product: { id: orig.id, name: orig.name }, substitutes: subs.map((p) => ({ id: p.id, name: p.name, dosage: p.dosage, form: p.form, isGeneric: p.is_generic, salePrice: Number(p.sale_price), available: p.available })) };
  });
  res.json(out);
}));

// Remplacement d'un produit par un équivalent, sur une ordonnance « à valider » : équivalence revérifiée côté serveur
router.post('/prescriptions/:id/items/:itemId/substitute', requirePermission('dispensation:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const itemId = v.uuid(req.params.itemId); const newId = v.uuid(req.body?.productId, 'produit');
  const out = await tx(ctx(req), async (c) => {
    const r = (await c.query('SELECT patient_id, status FROM prescriptions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new AppError(404, 'Ordonnance introuvable');
    if (r.status !== 'pending') throw new AppError(409, 'La substitution n\'est possible que sur une ordonnance « à valider »');
    const it = (await c.query('SELECT i.id, i.product_id, p.id AS pid, p.name, p.dci, p.dosage, p.form FROM prescription_items i JOIN products p ON p.id = i.product_id WHERE i.id = $1 AND i.prescription_id = $2', [itemId, id])).rows[0];
    if (!it) throw new AppError(404, 'Ligne introuvable');
    const np = (await c.query('SELECT id, name, dci, dosage, form FROM products WHERE id = $1 AND is_active', [newId])).rows[0];
    if (!np) throw new AppError(404, 'Produit de substitution introuvable ou inactif');
    if (!isEquivalent({ id: it.pid, dci: it.dci, dosage: it.dosage, form: it.form }, np)) throw new AppError(409, 'Ce produit n\'est pas un équivalent (mêmes substances, dosage et forme requis)');
    if ((await c.query('SELECT 1 FROM prescription_items WHERE prescription_id = $1 AND product_id = $2', [id, newId])).rowCount) throw new AppError(409, 'Ce produit figure déjà sur l\'ordonnance');
    await c.query('UPDATE prescription_items SET product_id = $2, substituted_from = COALESCE(substituted_from, $3) WHERE id = $1', [itemId, newId, it.product_id]);
    const pat = (await c.query('SELECT allergies FROM patients WHERE id = $1', [r.patient_id])).rows[0];
    const prods = (await c.query('SELECT p.id, p.name, p.dci FROM prescription_items i JOIN products p ON p.id = i.product_id WHERE i.prescription_id = $1', [id])).rows;
    const alerts = await computeAlerts(c, { patientId: r.patient_id, allergies: pat.allergies, products: prods });
    await c.query('UPDATE prescriptions SET alerts = $2, alerts_acknowledged = false WHERE id = $1', [id, JSON.stringify(alerts)]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'prescription.item_substituted', entity: 'prescription', entityId: id, meta: { from: it.name, to: np.name }, ip: req.ip });
    return { ok: true, alerts };
  });
  res.json(out);
}));

// ---- Étiquettes de posologie (données prêtes à imprimer) ----
router.get('/prescriptions/:id/labels', requirePermission('dispensation:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const r = (await c.query(`${RX_SQL} WHERE r.id = $1`, [id])).rows[0];
    if (!r) throw new AppError(404, 'Ordonnance introuvable');
    if (!['validated', 'dispensed'].includes(r.status)) throw new AppError(409, 'Les étiquettes sont disponibles après validation par le pharmacien');
    const items = (await c.query('SELECT i.product_id, i.quantity, i.posology, p.name, p.dosage, p.form FROM prescription_items i JOIN products p ON p.id = i.product_id WHERE i.prescription_id = $1 ORDER BY p.name', [id])).rows;
    const lots = (await c.query(`SELECT m.product_id, l.lot_number, l.expiry_date FROM stock_movements m JOIN stock_lots l ON l.id = m.lot_id WHERE m.ref_id = $1 AND m.type = 'dispensation'`, [id])).rows;
    return { pharmacy: req.user.tenantName, number: num(r.number), patientName: r.patient_name, prescribedOn: r.prescribed_on, dispensedAt: r.dispensed_at, status: r.status,
      labels: items.map((i) => ({ product: i.name, dosage: i.dosage, form: i.form, quantity: i.quantity, posology: i.posology, lots: lots.filter((l) => l.product_id === i.product_id).map((l) => ({ lotNumber: l.lot_number, expiryDate: l.expiry_date })) })) };
  });
  res.json(out);
}));

module.exports = router;
