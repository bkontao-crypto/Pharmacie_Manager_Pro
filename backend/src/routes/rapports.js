'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { csvCell } = require('../lib/csv');
const { localDate, localDateTime } = require('../lib/tz');
const { buildXlsx } = require('../lib/xlsx');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const iso = (d) => d.toISOString().slice(0, 10);

/** Période [from, to] (inclus), 30 derniers jours par défaut, 366 jours maximum. */
function period(q, tz) {
  const to = v.date(typeof q.to === 'string' ? q.to : '', 'fin') || localDate(new Date(), tz);
  const from = v.date(typeof q.from === 'string' ? q.from : '', 'début') || iso(new Date(Date.parse(to) - 29 * 86400000));
  if (from > to) throw new AppError(400, 'La date de début doit précéder la date de fin');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new AppError(400, 'Période limitée à 366 jours');
  return { from, to };
}
const n = (x) => Number(x || 0);

// Indicateurs de la période (ventes encaissées ; les ventes remboursées sont comptées à part). Appelé dans une transaction.
async function overviewData(c, from, to) {
  const data = await (async () => {
    const P = [from, to];
    const WHERE = `app_date(s.created_at) BETWEEN $1::date AND $2::date`;
    const k = (await c.query(`
      SELECT count(*) FILTER (WHERE s.status = 'paid')::int AS sales_count,
             COALESCE(SUM(s.total) FILTER (WHERE s.status = 'paid'), 0) AS revenue,
             COALESCE(SUM(s.discount_amount) FILTER (WHERE s.status = 'paid'), 0) AS discounts,
             COALESCE(SUM(s.total) FILTER (WHERE s.status = 'refunded'), 0) AS refunded,
             COALESCE(SUM((SELECT SUM(i.quantity * i.unit_cost) FROM sale_items i WHERE i.sale_id = s.id)) FILTER (WHERE s.status = 'paid'), 0) AS cost,
             count(DISTINCT s.patient_id) FILTER (WHERE s.status = 'paid')::int AS patients
        FROM sales s WHERE ${WHERE}`, P)).rows[0];
    const byDay = (await c.query(`SELECT app_date(s.created_at) AS day, count(*)::int AS count, SUM(s.total) AS revenue FROM sales s WHERE ${WHERE} AND s.status = 'paid' GROUP BY 1 ORDER BY 1`, P)).rows;
    const byMethod = (await c.query(`SELECT p.method, SUM(p.amount) AS amount FROM payments p JOIN sales s ON s.id = p.sale_id WHERE ${WHERE} AND s.status = 'paid' GROUP BY 1 ORDER BY 2 DESC`, P)).rows;
    const top = (await c.query(`SELECT pr.name, SUM(i.quantity)::int AS qty, SUM(i.quantity * i.unit_price) AS revenue, SUM(i.quantity * (i.unit_price - i.unit_cost)) AS margin
        FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products pr ON pr.id = i.product_id WHERE ${WHERE} AND s.status = 'paid' GROUP BY pr.id, pr.name ORDER BY revenue DESC LIMIT 10`, P)).rows;
    const ops = (await c.query(`SELECT u.email, u.full_name, count(*)::int AS count, SUM(s.total) AS revenue FROM sales s JOIN users u ON u.id = s.created_by WHERE ${WHERE} AND s.status = 'paid' GROUP BY u.id ORDER BY revenue DESC`, P)).rows;
    const stock = (await c.query(`
      SELECT COALESCE(SUM(l.quantity * p.purchase_price) FILTER (WHERE l.expiry_date >= app_today()), 0) AS value,
             COALESCE(SUM(l.quantity * p.purchase_price) FILTER (WHERE l.expiry_date < app_today()), 0) AS expired_value,
             COALESCE(SUM(l.quantity) FILTER (WHERE l.expiry_date >= app_today()), 0)::int AS units
        FROM stock_lots l JOIN products p ON p.id = l.product_id WHERE l.quantity > 0`)).rows[0];
    return { k, byDay, byMethod, top, ops, stock };
  })();
  const revenue = n(data.k.revenue); const cost = n(data.k.cost); const count = data.k.sales_count;
  return {
    period: { from, to },
    kpis: { revenue, salesCount: count, avgBasket: count ? Math.round((revenue / count) * 100) / 100 : 0, margin: Math.round((revenue - cost) * 100) / 100, marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
      discounts: n(data.k.discounts), refunded: n(data.k.refunded), distinctPatients: data.k.patients },
    byDay: data.byDay.map((d) => ({ day: d.day, count: d.count, revenue: n(d.revenue) })),
    byMethod: data.byMethod.map((m) => ({ method: m.method, amount: n(m.amount) })),
    topProducts: data.top.map((t) => ({ name: t.name, quantity: t.qty, revenue: n(t.revenue), margin: n(t.margin) })),
    byOperator: data.ops.map((o) => ({ name: o.full_name, email: o.email, count: o.count, revenue: n(o.revenue) })),
    stockValuation: { value: n(data.stock.value), expiredValue: n(data.stock.expired_value), units: data.stock.units },
  };
}

router.get('/overview', requirePermission('rapports:read'), wrap(async (req, res) => {
  const { from, to } = period(req.query, req.user.timezone);
  res.json(await tx(ctx(req), (c) => overviewData(c, from, to)));
}));

// Ventes de la période (sans donnée nominative de patient) : base commune des exports CSV et Excel
const SALES_ROWS_SQL = `
  SELECT s.number, s.created_at, s.status, s.subtotal, s.discount_amount, s.total, u.email,
         (SELECT string_agg(p.method || ':' || p.amount, ' | ' ORDER BY p.id) FROM payments p WHERE p.sale_id = s.id) AS payments
    FROM sales s LEFT JOIN users u ON u.id = s.created_by WHERE app_date(s.created_at) BETWEEN $1::date AND $2::date ORDER BY s.created_at`;
const saleNo = (r) => `VTE-${String(r.number).padStart(6, '0')}`;
const STATUS_FR = (st) => (st === 'paid' ? 'Encaissée' : 'Remboursée');
const METHOD_FR = { especes: 'Espèces', mobile_money: 'Mobile money', carte: 'Carte', tiers_payant: 'Tiers-payant' };

// Export CSV (séparateur « ; », UTF-8 avec BOM → s'ouvre directement dans Excel en français)
// Pas de données nominatives de patients dans l'export (minimisation des données de santé).
router.get('/export/sales.csv', requirePermission('rapports:export'), wrap(async (req, res) => {
  const { from, to } = period(req.query, req.user.timezone);
  const rows = await tx(ctx(req), async (c) => {
    const r = (await c.query(SALES_ROWS_SQL, [from, to])).rows;
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'report.exported', entity: 'sales', meta: { from, to, rows: r.length }, ip: req.ip });
    return r;
  });
  const head = ['Numéro', 'Date (heure locale)', 'Statut', 'Sous-total', 'Remise', 'Total', 'Paiements', 'Opérateur'];
  const lines = rows.map((r) => [saleNo(r), localDateTime(r.created_at, req.user.timezone), STATUS_FR(r.status), r.subtotal, r.discount_amount, r.total, r.payments, r.email].map(csvCell).join(';'));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ventes_${from}_${to}.csv"`, 'Cache-Control': 'no-store' });
  res.send(`\uFEFF${[head.join(';'), ...lines].join('\r\n')}\r\n`);
}));

// Export Excel (.xlsx) : synthèse + détail par jour, paiements, produits, opérateurs et liste des ventes. Mêmes règles que le CSV (aucun nom de patient).
router.get('/export/report.xlsx', requirePermission('rapports:export'), wrap(async (req, res) => {
  const { from, to } = period(req.query, req.user.timezone);
  const { o, sales } = await tx(ctx(req), async (c) => {
    const o = await overviewData(c, from, to);
    const sales = (await c.query(SALES_ROWS_SQL, [from, to])).rows;
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'report.exported', entity: 'report', meta: { from, to, format: 'xlsx', sales: sales.length }, ip: req.ip });
    return { o, sales };
  });
  const H = (...t) => t.map((v2) => ({ v: v2, s: 'head' }));
  const money = (v2) => ({ v: v2, s: 'money' }); const int = (v2) => ({ v: v2, s: 'int' });
  const k = o.kpis;
  const sheets = [
    { name: 'Synthèse', widths: [38, 18], rows: [
      [{ v: `${req.user.tenantName || 'Pharmacie'} — Rapport du ${from} au ${to}`, s: 'title' }], [],
      H('Indicateur', 'Valeur'),
      ['Chiffre d’affaires', money(k.revenue)], ['Nombre de ventes', int(k.salesCount)], ['Panier moyen', money(k.avgBasket)],
      ['Marge brute', money(k.margin)], ['Marge brute (%)', { v: k.marginPct, s: 'money' }], ['Remises accordées', money(k.discounts)],
      ['Remboursements', money(k.refunded)], ['Patients distincts servis', int(k.distinctPatients)],
      ['Valeur du stock (prix d’achat)', money(o.stockValuation.value)], ['Stock périmé à sortir (prix d’achat)', money(o.stockValuation.expiredValue)], ['Unités en stock (non périmées)', int(o.stockValuation.units)],
    ] },
    { name: 'Par jour', widths: [14, 10, 18], rows: [H('Jour', 'Ventes', 'CA'), ...o.byDay.map((d) => [d.day, int(d.count), money(d.revenue)])] },
    { name: 'Paiements', widths: [22, 18], rows: [H('Moyen de paiement', 'Montant'), ...o.byMethod.map((m) => [METHOD_FR[m.method] || m.method, money(m.amount)])] },
    { name: 'Top produits', widths: [40, 10, 16, 16], rows: [H('Produit', 'Quantité', 'CA', 'Marge'), ...o.topProducts.map((t) => [t.name, int(t.quantity), money(t.revenue), money(t.margin)])] },
    { name: 'Opérateurs', widths: [34, 10, 18], rows: [H('Opérateur', 'Ventes', 'CA'), ...o.byOperator.map((x) => [x.name || x.email, int(x.count), money(x.revenue)])] },
    { name: 'Ventes', widths: [14, 22, 14, 14, 12, 14, 36, 30], rows: [H('Numéro', 'Date (heure locale)', 'Statut', 'Sous-total', 'Remise', 'Total', 'Paiements', 'Opérateur'),
      ...sales.map((r) => [saleNo(r), localDateTime(r.created_at, req.user.timezone), STATUS_FR(r.status), money(Number(r.subtotal)), money(Number(r.discount_amount)), money(Number(r.total)), r.payments, r.email])] },
  ];
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="rapport_${from}_${to}.xlsx"`, 'Cache-Control': 'no-store' });
  res.send(buildXlsx(sheets));
}));

module.exports = { router, overviewData, period };
