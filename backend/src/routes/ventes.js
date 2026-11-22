'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { computeTotals, paymentsTotalCents, toCents, fromCents } = require('../lib/money');
const { earnedPoints, redeemValueCents } = require('../lib/loyalty');
const { loyaltyBalance, loyaltySettings, addLedger } = require('../lib/loyaltyDb');
const { consumeFEFO, restock } = require('../lib/stockOps');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
// La vente sort du stock : le module Stocks doit être activé.
router.use((req, res, next) => (req.user.enabledModules.includes('stocks') ? next() : next(new AppError(409, 'La caisse nécessite le module Stocks', 'MODULE_DEPENDENCY'))));
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const num = (n) => `VTE-${String(n).padStart(6, '0')}`;
const METHODS = ['especes', 'mobile_money', 'carte', 'tiers_payant'];
const like = (q) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

const SALE_SQL = `SELECT s.*, u.email AS user_email, p.last_name || ' ' || p.first_name AS patient_name,
    (SELECT number FROM prescriptions r WHERE r.id = s.prescription_id) AS rx_number
  FROM sales s LEFT JOIN users u ON u.id = s.created_by LEFT JOIN patients p ON p.id = s.patient_id`;
const toSale = (r, red = false) => ({ id: r.id, number: num(r.number), status: r.status, subtotal: Number(r.subtotal), discountPct: Number(r.discount_pct), discountAmount: Number(r.discount_amount), total: Number(r.total),
  patientName: red ? null : r.patient_name, prescriptionNumber: red ? null : r.rx_number ? `ORD-${String(r.rx_number).padStart(6, '0')}` : null, userEmail: r.user_email, createdAt: r.created_at, refundedAt: r.refunded_at, refundReason: r.refund_reason,
  redeemedPoints: r.redeemed_points, redeemAmount: Number(r.redeem_amount), earnedPoints: r.earned_points });

// Recherche produits pour la caisse (prix + stock, sans exiger stocks:read)
router.get('/lookup/products', requirePermission('ventes:write'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT p.id, p.name, p.dci, p.dosage, p.sale_price, p.requires_prescription,
            COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.product_id = p.id AND l.expiry_date >= app_today()), 0)::int AS available
       FROM products p WHERE p.is_active AND ($1 = '' OR p.name ILIKE $2 OR p.dci ILIKE $2 OR p.barcode = $1) ORDER BY lower(p.name) LIMIT 20`, [q, like(q)])).rows);
  res.json({ products: rows.map((r) => ({ id: r.id, name: r.name, dci: r.dci, dosage: r.dosage, unitPrice: Number(r.sale_price), requiresPrescription: r.requires_prescription, available: r.available })) });
}));

// Recherche de patients pour la caisse (nom + solde de points, sans exiger patients:read)
router.get('/lookup/patients', requirePermission('ventes:write'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const out = await tx(ctx(req), async (c) => {
    const cfg = await loyaltySettings(c, req.user.tenantId);
    const rows = (await c.query(
      `SELECT pa.id, pa.last_name, pa.first_name, COALESCE((SELECT SUM(l.points) FROM loyalty_ledger l WHERE l.patient_id = pa.id), 0)::int AS points
         FROM patients pa WHERE pa.is_active AND ($1 = '' OR pa.last_name ILIKE $2 OR pa.first_name ILIKE $2 OR pa.phone ILIKE $2) ORDER BY lower(pa.last_name) LIMIT 20`, [q, like(q)])).rows;
    return { loyalty: { enabled: cfg.enabled, pointValue: cfg.pointValue, earnAmount: cfg.earnAmount }, patients: rows.map((r) => ({ id: r.id, name: `${r.last_name} ${r.first_name}`, points: cfg.enabled ? r.points : null })) };
  });
  res.json(out);
}));

// Ordonnances délivrées, pas encore facturées
router.get('/billable-prescriptions', requirePermission('ventes:write'), wrap(async (req, res) => {
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT r.id, r.number, r.prescribed_on, pa.last_name || ' ' || pa.first_name AS patient_name,
            (SELECT SUM(i.quantity * pr.sale_price) FROM prescription_items i JOIN products pr ON pr.id = i.product_id WHERE i.prescription_id = r.id) AS total
       FROM prescriptions r JOIN patients pa ON pa.id = r.patient_id
      WHERE r.status = 'dispensed' AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.prescription_id = r.id AND s.status = 'paid')
      ORDER BY r.dispensed_at DESC LIMIT 50`)).rows);
  res.json({ prescriptions: rows.map((r) => ({ id: r.id, number: `ORD-${String(r.number).padStart(6, '0')}`, patientName: r.patient_name, prescribedOn: r.prescribed_on, total: Number(r.total || 0) })) });
}));

// Encaissement
router.post('/sales', requirePermission('ventes:write'), wrap(async (req, res) => {
  const b = req.body || {};
  let discountPct = 0;
  if (b.discountPct !== undefined) {
    if (typeof b.discountPct !== 'number' || !(b.discountPct >= 0 && b.discountPct <= 100)) throw new AppError(400, 'Remise : entre 0 et 100 %');
    discountPct = Math.round(b.discountPct * 100) / 100;
  }
  if (!Array.isArray(b.payments) || b.payments.length < 1 || b.payments.length > 6) throw new AppError(400, 'Entre 1 et 6 paiements requis');
  const payments = b.payments.map((p) => ({ method: v.oneOf(p?.method, METHODS, 'moyen de paiement'), amount: v.money(p?.amount, 'montant'), reference: v.optStr(p?.reference, { max: 80, field: 'référence' }) }));
  if (payments.some((p) => p.amount <= 0)) throw new AppError(400, 'Chaque paiement doit être supérieur à 0');
  const prescriptionId = b.prescriptionId ? v.uuid(b.prescriptionId, 'ordonnance') : null;
  const redeemPoints = b.redeemPoints === undefined ? 0 : v.int(b.redeemPoints, { min: 0, max: 1000000, field: 'points utilisés' });
  let reqItems = [];
  if (!prescriptionId) {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 60) throw new AppError(400, 'Entre 1 et 60 lignes requises');
    reqItems = b.items.map((i) => ({ productId: v.uuid(i?.productId, 'produit'), quantity: v.int(i?.quantity, { min: 1, max: 1000, field: 'quantité' }) }));
    if (new Set(reqItems.map((i) => i.productId)).size !== reqItems.length) throw new AppError(400, 'Un produit apparaît plusieurs fois : regroupez les quantités');
  }

  const out = await tx(ctx(req), async (c) => {
    let patientId = null; let lines;
    if (prescriptionId) {
      const r = (await c.query('SELECT id, status, patient_id FROM prescriptions WHERE id = $1 FOR UPDATE', [prescriptionId])).rows[0];
      if (!r) throw new AppError(404, 'Ordonnance introuvable');
      if (r.status !== 'dispensed') throw new AppError(409, 'Seule une ordonnance délivrée peut être facturée');
      if ((await c.query(`SELECT 1 FROM sales WHERE prescription_id = $1 AND status = 'paid'`, [prescriptionId])).rowCount) throw new AppError(409, 'Cette ordonnance est déjà facturée');
      patientId = r.patient_id;
      lines = (await c.query('SELECT i.product_id, i.quantity, p.name, p.sale_price, p.purchase_price FROM prescription_items i JOIN products p ON p.id = i.product_id WHERE i.prescription_id = $1 ORDER BY i.product_id', [prescriptionId])).rows;
    } else {
      lines = (await c.query('SELECT id AS product_id, name, sale_price, purchase_price, requires_prescription FROM products WHERE id = ANY($1::uuid[]) AND is_active ORDER BY id', [reqItems.map((i) => i.productId)])).rows;
      if (lines.length !== reqItems.length) throw new AppError(404, 'Produit introuvable ou inactif');
      const q = new Map(reqItems.map((i) => [i.productId, i.quantity]));
      lines.forEach((l) => { l.quantity = q.get(l.product_id); });
      const rx = lines.find((l) => l.requires_prescription);
      if (rx) throw new AppError(409, `« ${rx.name} » est délivré sur ordonnance : passez par la dispensation`, 'PRESCRIPTION_REQUIRED');
      if (b.patientId) { patientId = v.uuid(b.patientId, 'patient'); if (!(await c.query('SELECT 1 FROM patients WHERE id = $1', [patientId])).rowCount) throw new AppError(404, 'Patient introuvable'); }
    }

    const base = computeTotals(lines.map((l) => ({ unitPrice: l.sale_price, quantity: l.quantity })), discountPct);
    const { subtotalCents, discountCents } = base; let totalCents = base.totalCents;
    const cfg = patientId ? await loyaltySettings(c, req.user.tenantId) : null;
    if (redeemPoints > 0) {
      if (!patientId) throw new AppError(400, 'Sélectionnez un patient pour utiliser des points');
      if (!cfg.enabled) throw new AppError(409, 'Le programme de fidélité n\'est pas activé', 'LOYALTY_DISABLED');
      await c.query('SELECT 1 FROM patients WHERE id = $1 FOR UPDATE', [patientId]);          // sérialise deux utilisations simultanées des mêmes points
      const balance = await loyaltyBalance(c, patientId);
      if (redeemPoints > balance) throw new AppError(409, `Solde insuffisant : ${balance} point(s) disponible(s)`, 'POINTS_INSUFFICIENT');
      const redeemCents = redeemValueCents(redeemPoints, toCents(cfg.pointValue));
      if (redeemCents >= totalCents) throw new AppError(409, 'Les points ne peuvent pas couvrir toute la vente', 'POINTS_TOO_HIGH');
      totalCents -= redeemCents; base.redeemCents = redeemCents;
    }
    if (totalCents <= 0) throw new AppError(400, 'Le total à encaisser doit être supérieur à 0');
    if (paymentsTotalCents(payments) !== totalCents) throw new AppError(409, `Le total des paiements (${fromCents(paymentsTotalCents(payments))}) doit égaler le total à payer (${fromCents(totalCents)})`, 'PAYMENT_MISMATCH');
    const earned = cfg && cfg.enabled ? earnedPoints(totalCents, toCents(cfg.earnAmount)) : 0;   // points sur le montant réellement payé

    const sale = (await c.query(
      `INSERT INTO sales (tenant_id, patient_id, prescription_id, subtotal, discount_pct, discount_amount, total, redeemed_points, redeem_amount, earned_points, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number`,
      [req.user.tenantId, patientId, prescriptionId, fromCents(subtotalCents), discountPct, fromCents(discountCents), fromCents(totalCents), redeemPoints, fromCents(base.redeemCents || 0), earned, req.user.id])).rows[0];
    for (const l of lines) {
      const item = (await c.query('INSERT INTO sale_items (tenant_id, sale_id, product_id, quantity, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.user.tenantId, sale.id, l.product_id, l.quantity, l.sale_price, l.purchase_price])).rows[0];
      if (!prescriptionId) { // vente comptoir : sortie de stock FEFO ; ordonnance : le stock est déjà sorti à la dispensation
        const used = await consumeFEFO(c, { tenantId: req.user.tenantId, userId: req.user.id, productId: l.product_id, productName: l.name, quantity: l.quantity, type: 'sale', reason: `Vente ${num(sale.number)}`, refId: sale.id });
        for (const a of used) await c.query('INSERT INTO sale_item_lots (tenant_id, sale_item_id, lot_id, quantity) VALUES ($1,$2,$3,$4)', [req.user.tenantId, item.id, a.lotId, a.quantity]);
      }
    }
    for (const p of payments) await c.query('INSERT INTO payments (tenant_id, sale_id, method, amount, reference) VALUES ($1,$2,$3,$4,$5)', [req.user.tenantId, sale.id, p.method, p.amount, p.reference]);
    if (redeemPoints > 0) await addLedger(c, { tenantId: req.user.tenantId, patientId, points: -redeemPoints, reason: `Utilisation sur ${num(sale.number)}`, saleId: sale.id, userId: req.user.id });
    if (earned > 0) await addLedger(c, { tenantId: req.user.tenantId, patientId, points: earned, reason: `Achat ${num(sale.number)}`, saleId: sale.id, userId: req.user.id });
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'sale.created', entity: 'sale', entityId: sale.id, meta: { number: num(sale.number), total: fromCents(totalCents), discountPct, redeemedPoints: redeemPoints, earnedPoints: earned, prescription: !!prescriptionId }, ip: req.ip });
    return { id: sale.id, number: num(sale.number), total: fromCents(totalCents), earnedPoints: earned, redeemedPoints: redeemPoints };
  });
  res.status(201).json(out);
}));

router.get('/sales', requirePermission('ventes:read'), wrap(async (req, res) => {
  const day = v.date(typeof req.query.date === 'string' ? req.query.date : '', 'date');
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase().replace(/^VTE-0*/, '') : '';
  const rows = await tx(ctx(req), async (c) => (await c.query(`${SALE_SQL} WHERE ($1::date IS NULL OR app_date(s.created_at) = $1::date) AND ($2 = '' OR s.number::text = $2) ORDER BY s.created_at DESC LIMIT 100`, [day, /^\d+$/.test(q) ? q : ''])).rows);
  res.json({ sales: rows.map((r) => toSale(r, req.user.patientDataRestricted)) });
}));

router.get('/sales/:id', requirePermission('ventes:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const s = (await c.query(`${SALE_SQL} WHERE s.id = $1`, [id])).rows[0];
    if (!s) throw new AppError(404, 'Vente introuvable');
    const items = (await c.query('SELECT i.quantity, i.unit_price, p.name, p.dosage FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY p.name', [id])).rows;
    const pays = (await c.query('SELECT method, amount, reference FROM payments WHERE sale_id = $1 ORDER BY id', [id])).rows;
    return { sale: toSale(s, req.user.patientDataRestricted), items: items.map((i) => ({ name: i.name, dosage: i.dosage, quantity: i.quantity, unitPrice: Number(i.unit_price) })), payments: pays.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference })) };
  });
  res.json(out);
}));

// Retour client : vente comptoir uniquement, remise en stock sur les lots d'origine
router.post('/sales/:id/refund', requirePermission('ventes:refund'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const reason = v.str(req.body?.reason, { min: 3, max: 300, field: 'motif' });
  await tx(ctx(req), async (c) => {
    const s = (await c.query('SELECT id, number, status, prescription_id, patient_id, redeemed_points, earned_points FROM sales WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!s) throw new AppError(404, 'Vente introuvable');
    if (s.status !== 'paid') throw new AppError(409, 'Cette vente est déjà remboursée');
    if (s.prescription_id) throw new AppError(409, 'Une vente sur ordonnance (médicaments déjà délivrés) ne peut pas être remboursée ici', 'PRESCRIPTION_SALE');
    const lots = (await c.query('SELECT sil.lot_id, sil.quantity, si.product_id FROM sale_item_lots sil JOIN sale_items si ON si.id = sil.sale_item_id WHERE si.sale_id = $1 ORDER BY sil.lot_id', [id])).rows;
    for (const l of lots) await restock(c, { tenantId: req.user.tenantId, userId: req.user.id, productId: l.product_id, lotId: l.lot_id, quantity: l.quantity, reason: `Retour ${num(s.number)}`, refId: id });
    if (s.patient_id && s.redeemed_points > 0) await addLedger(c, { tenantId: req.user.tenantId, patientId: s.patient_id, points: s.redeemed_points, reason: `Remboursement ${num(s.number)} : points restitués`, saleId: id, userId: req.user.id });
    if (s.patient_id && s.earned_points > 0) await addLedger(c, { tenantId: req.user.tenantId, patientId: s.patient_id, points: -s.earned_points, reason: `Remboursement ${num(s.number)} : points annulés`, saleId: id, userId: req.user.id });
    await c.query(`UPDATE sales SET status = 'refunded', refunded_by = $2, refunded_at = now(), refund_reason = $3 WHERE id = $1`, [id, req.user.id, reason]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'sale.refunded', entity: 'sale', entityId: id, meta: { number: num(s.number), reason }, ip: req.ip });
  });
  res.json({ ok: true });
}));

module.exports = router;
