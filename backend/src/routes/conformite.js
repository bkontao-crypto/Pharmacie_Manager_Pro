'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { csvCell } = require('../lib/csv');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const { localDate, localDateTime } = require('../lib/tz');
const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
router.use((req, res, next) => (req.user.enabledModules.includes('stocks') ? next() : next(new AppError(409, 'La conformité nécessite le module Stocks', 'MODULE_DEPENDENCY'))));
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const iso = (d) => d.toISOString().slice(0, 10);
const TYPE_LABEL = { reception: 'Entrée (réception)', adjustment: 'Ajustement', dispensation: 'Dispensation', sale: 'Vente comptoir', return: 'Retour client', transfer_out: 'Transfert sortant', transfer_in: 'Transfert entrant', transfer_return: 'Retour de transfert' };

// Rappel de lot : où est passé chaque lot ? Quels patients contacter ?
router.get('/lot-trace', requirePermission('conformite:read'), wrap(async (req, res) => {
  const lotNumber = v.str(typeof req.query.lotNumber === 'string' ? req.query.lotNumber : '', { max: 60, field: 'n° de lot' });
  const out = await tx(ctx(req), async (c) => {
    const lots = (await c.query(`SELECT l.id, l.lot_number, l.expiry_date, l.quantity, p.id AS product_id, p.name, p.dci FROM stock_lots l JOIN products p ON p.id = l.product_id WHERE lower(l.lot_number) = lower($1) ORDER BY p.name`, [lotNumber])).rows;
    if (!lots.length) throw new AppError(404, 'Aucun lot avec ce numéro');
    const result = [];
    for (const l of lots) {
      const mv = (await c.query(`SELECT m.id, m.type, m.quantity, m.created_at, m.ref_id, u.email AS user_email FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.lot_id = $1 ORDER BY m.id`, [l.id])).rows;
      const rxIds = [...new Set(mv.filter((m) => m.type === 'dispensation').map((m) => m.ref_id).filter(Boolean))];
      const saleIds = [...new Set(mv.filter((m) => ['sale', 'return'].includes(m.type)).map((m) => m.ref_id).filter(Boolean))];
      const rx = rxIds.length ? (await c.query(`SELECT r.id, r.number, pa.last_name || ' ' || pa.first_name AS patient, pa.phone FROM prescriptions r JOIN patients pa ON pa.id = r.patient_id WHERE r.id = ANY($1::uuid[])`, [rxIds])).rows : [];
      const sales = saleIds.length ? (await c.query(`SELECT s.id, s.number, pa.last_name || ' ' || pa.first_name AS patient, pa.phone FROM sales s LEFT JOIN patients pa ON pa.id = s.patient_id WHERE s.id = ANY($1::uuid[])`, [saleIds])).rows : [];
      const rxMap = new Map(rx.map((r) => [r.id, r])); const saleMap = new Map(sales.map((s) => [s.id, s]));
      const sum = (types) => mv.filter((m) => types.includes(m.type)).reduce((t, m) => t + m.quantity, 0);
      result.push({
        product: { id: l.product_id, name: l.name, dci: l.dci }, lotNumber: l.lot_number, expiryDate: l.expiry_date, remaining: l.quantity,
        totals: { received: sum(['reception']), dispensed: -sum(['dispensation']), soldOverCounter: -sum(['sale']), returned: sum(['return']), adjusted: sum(['adjustment']) },
        movements: mv.map((m) => { const r = m.type === 'dispensation' ? rxMap.get(m.ref_id) : saleMap.get(m.ref_id);
          return { type: m.type, typeLabel: TYPE_LABEL[m.type], quantity: m.quantity, date: m.created_at, user: m.user_email,
            reference: m.type === 'dispensation' && r ? `ORD-${String(r.number).padStart(6, '0')}` : r ? `VTE-${String(r.number).padStart(6, '0')}` : null, patient: req.user.patientDataRestricted ? null : r?.patient || null, phone: req.user.patientDataRestricted ? null : r?.phone || null }; }),
      });
    }
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'compliance.lot_trace', entity: 'lot', entityId: lotNumber, meta: { lots: lots.length }, ip: req.ip });
    return { lots: result };
  });
  res.json(out);
}));

/** Registre des produits contrôlés : solde d'ouverture, mouvements de la période avec solde courant, solde de clôture. */
async function controlledRegister(c, from, to) {
  const rows = (await c.query(
    `SELECT m.id, m.product_id, p.name, p.dci, m.type, m.quantity, m.created_at, app_date(m.created_at) AS day, m.reason, l.lot_number, u.email AS user_email
       FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN stock_lots l ON l.id = m.lot_id LEFT JOIN users u ON u.id = m.user_id
      WHERE p.is_controlled AND app_date(m.created_at) <= $1::date ORDER BY p.name, m.id`, [to])).rows;
  const byProduct = new Map();
  for (const r of rows) {
    const e = byProduct.get(r.product_id) || { productId: r.product_id, name: r.name, dci: r.dci, opening: 0, closing: 0, movements: [] };
    if (r.day < from) e.opening += r.quantity;
    byProduct.set(r.product_id, e);
  }
  for (const e of byProduct.values()) e.closing = e.opening;
  for (const r of rows) {
    if (r.day < from) continue;
    const e = byProduct.get(r.product_id); e.closing += r.quantity;
    e.movements.push({ date: r.created_at, type: r.type, typeLabel: TYPE_LABEL[r.type], quantity: r.quantity, balance: e.closing, lotNumber: r.lot_number, reason: r.reason, user: r.user_email });
  }
  return [...byProduct.values()];
}
function period(q, tz) {
  const to = v.date(typeof q.to === 'string' ? q.to : '', 'fin') || localDate(new Date(), tz);
  const from = v.date(typeof q.from === 'string' ? q.from : '', 'début') || iso(new Date(Date.parse(to) - 29 * 86400000));
  if (from > to) throw new AppError(400, 'La date de début doit précéder la date de fin');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new AppError(400, 'Période limitée à 366 jours');
  return { from, to };
}

router.get('/controlled-register', requirePermission('conformite:read'), wrap(async (req, res) => {
  const { from, to } = period(req.query, req.user.timezone);
  const products = await tx(ctx(req), (c) => controlledRegister(c, from, to));
  res.json({ period: { from, to }, products });
}));

router.get('/controlled-register.csv', requirePermission('conformite:export'), wrap(async (req, res) => {
  const { from, to } = period(req.query, req.user.timezone);
  const products = await tx(ctx(req), async (c) => { const r = await controlledRegister(c, from, to); await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'compliance.register_exported', entity: 'register', meta: { from, to }, ip: req.ip }); return r; });
  const head = ['Produit', 'DCI', 'Date (heure locale)', 'Mouvement', 'Quantité', 'Solde', 'Lot', 'Motif', 'Opérateur'];
  const lines = [];
  for (const p of products) {
    lines.push([p.name, p.dci, `Solde d'ouverture au ${from}`, '', '', p.opening, '', '', ''].map(csvCell).join(';'));
    for (const m of p.movements) lines.push([p.name, p.dci, localDateTime(m.date, req.user.timezone), m.typeLabel, m.quantity, m.balance, m.lotNumber, m.reason, m.user].map(csvCell).join(';'));
    lines.push([p.name, p.dci, `Solde de clôture au ${to}`, '', '', p.closing, '', '', ''].map(csvCell).join(';'));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="registre_controles_${from}_${to}.csv"`, 'Cache-Control': 'no-store' });
  res.send(`\uFEFF${[head.join(';'), ...lines].join('\r\n')}\r\n`);
}));

module.exports = router;
