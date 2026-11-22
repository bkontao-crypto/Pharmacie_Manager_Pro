'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { stockStatus, expiryStatus, today } = require('../lib/stock');
const { receiveLot } = require('../lib/stockOps');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });

const PRODUCT_AGG = `
  SELECT p.*, COALESCE(SUM(l.quantity) FILTER (WHERE l.expiry_date >= app_today()), 0)::int AS available,
         COALESCE(SUM(l.quantity), 0)::int AS total_qty,
         MIN(l.expiry_date) FILTER (WHERE l.quantity > 0 AND l.expiry_date >= app_today()) AS next_expiry
    FROM products p LEFT JOIN stock_lots l ON l.product_id = p.id`;
const toProduct = (r) => ({
  id: r.id, name: r.name, dci: r.dci, barcode: r.barcode, form: r.form, dosage: r.dosage,
  salePrice: Number(r.sale_price), purchasePrice: Number(r.purchase_price), minStock: r.min_stock, maxStock: r.max_stock,
  requiresPrescription: r.requires_prescription, isGeneric: r.is_generic, isControlled: r.is_controlled, renewalDays: r.renewal_days, isActive: r.is_active,
  available: r.available, totalQty: r.total_qty, nextExpiry: r.next_expiry, status: stockStatus(r.available, r.min_stock),
});

function parseProduct(b, partial) {
  const o = {}; const has = (k) => b[k] !== undefined;
  if (!partial || has('name')) o.name = v.str(b.name, { max: 160, field: 'nom' });
  if (has('dci')) o.dci = v.optStr(b.dci, { max: 160, field: 'DCI' });
  if (has('barcode')) o.barcode = v.optStr(b.barcode, { max: 64, field: 'code-barres' });
  if (has('form')) o.form = v.optStr(b.form, { max: 60, field: 'forme' });
  if (has('dosage')) o.dosage = v.optStr(b.dosage, { max: 60, field: 'dosage' });
  if (has('salePrice')) o.sale_price = v.money(b.salePrice, 'prix de vente');
  if (has('purchasePrice')) o.purchase_price = v.money(b.purchasePrice, 'prix d\'achat');
  if (has('minStock')) o.min_stock = v.int(b.minStock, { field: 'seuil min' });
  if (has('maxStock')) o.max_stock = b.maxStock === null ? null : v.int(b.maxStock, { field: 'seuil max' });
  if (has('requiresPrescription')) o.requires_prescription = v.bool(b.requiresPrescription, 'sur ordonnance');
  if (has('renewalDays')) o.renewal_days = b.renewalDays === null || b.renewalDays === '' ? null : v.int(b.renewalDays, { min: 1, max: 365, field: 'cycle de renouvellement (jours)' });
  if (has('isGeneric')) o.is_generic = v.bool(b.isGeneric, 'générique');
  if (has('isControlled')) o.is_controlled = v.bool(b.isControlled, 'produit contrôlé');
  if (has('isActive')) o.is_active = v.bool(b.isActive, 'actif');
  return o;
}

// GET /api/stocks/products?q=&status=rupture|bas
router.get('/products', requirePermission('stocks:read'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `${PRODUCT_AGG} WHERE p.is_active AND ($1 = '' OR p.name ILIKE $2 OR p.dci ILIKE $2 OR p.barcode = $1)
      GROUP BY p.id ORDER BY lower(p.name) LIMIT 300`, [q, like])).rows);
  let products = rows.map(toProduct);
  if (['rupture', 'bas'].includes(req.query.status)) products = products.filter((p) => p.status === req.query.status);
  res.json({ products });
}));

// POST /api/stocks/products
router.post('/products', requirePermission('stocks:write'), wrap(async (req, res) => {
  const o = parseProduct(req.body || {}, false); const cols = Object.keys(o);
  const row = await tx(ctx(req), async (c) => {
    const r = (await c.query(`INSERT INTO products (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`, [req.user.tenantId, ...cols.map((k) => o[k])])).rows[0];
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'product.created', entity: 'product', entityId: r.id, meta: { name: o.name }, ip: req.ip });
    return (await c.query(`${PRODUCT_AGG} WHERE p.id = $1 GROUP BY p.id`, [r.id])).rows[0];
  });
  res.status(201).json({ product: toProduct(row) });
}));

// PATCH /api/stocks/products/:id
router.patch('/products/:id', requirePermission('stocks:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const o = parseProduct(req.body || {}, true); const cols = Object.keys(o);
  if (!cols.length) throw new AppError(400, 'Aucune modification');
  const row = await tx(ctx(req), async (c) => {
    const r = await c.query(`UPDATE products SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((k) => o[k])]);
    if (!r.rowCount) throw new AppError(404, 'Produit introuvable');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'product.updated', entity: 'product', entityId: id, meta: { fields: cols }, ip: req.ip });
    return (await c.query(`${PRODUCT_AGG} WHERE p.id = $1 GROUP BY p.id`, [id])).rows[0];
  });
  res.json({ product: toProduct(row) });
}));

// GET /api/stocks/products/:id — lots + derniers mouvements
router.get('/products/:id', requirePermission('stocks:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const p = (await c.query(`${PRODUCT_AGG} WHERE p.id = $1 GROUP BY p.id`, [id])).rows[0];
    if (!p) throw new AppError(404, 'Produit introuvable');
    const lots = (await c.query('SELECT id, lot_number, expiry_date, quantity, received_at FROM stock_lots WHERE product_id = $1 ORDER BY expiry_date, lot_number', [id])).rows;
    const movements = (await c.query(
      `SELECT m.id, m.type, m.quantity, m.reason, m.created_at, l.lot_number, u.email AS user_email
         FROM stock_movements m LEFT JOIN stock_lots l ON l.id = m.lot_id LEFT JOIN users u ON u.id = m.user_id
        WHERE m.product_id = $1 ORDER BY m.id DESC LIMIT 30`, [id])).rows;
    const day = today(req.user.timezone);
    return { product: toProduct(p), lots: lots.map((l) => ({ ...l, expiryStatus: expiryStatus(l.expiry_date, day) })), movements };
  });
  res.json(out);
}));

// POST /api/stocks/receive — entrée en stock d'un lot (cumule si le lot existe déjà)
router.post('/receive', requirePermission('stocks:write'), wrap(async (req, res) => {
  const b = req.body || {};
  const productId = v.uuid(b.productId, 'produit'); const lotNumber = v.str(b.lotNumber, { max: 60, field: 'n° de lot' });
  const expiry = v.date(b.expiryDate, 'péremption'); if (!expiry) throw new AppError(400, 'Date de péremption requise');
  const qty = v.int(b.quantity, { min: 1, max: 1000000, field: 'quantité' });
  const lot = await tx(ctx(req), (c) => receiveLot(c, { tenantId: req.user.tenantId, userId: req.user.id, ip: req.ip, productId, lotNumber, expiry, qty, reason: v.optStr(b.reason, { max: 200, field: 'motif' }) }));
  res.status(201).json({ lotId: lot });
}));

// POST /api/stocks/adjust — inventaire / correction (motif obligatoire, tracé)
router.post('/adjust', requirePermission('stocks:adjust'), wrap(async (req, res) => {
  const b = req.body || {};
  const lotId = v.uuid(b.lotId, 'lot'); const newQty = v.int(b.newQuantity, { max: 1000000, field: 'nouvelle quantité' });
  const reason = v.str(b.reason, { min: 3, max: 200, field: 'motif' });
  const out = await tx(ctx(req), async (c) => {
    const l = (await c.query('SELECT id, product_id, quantity FROM stock_lots WHERE id = $1 FOR UPDATE', [lotId])).rows[0];
    if (!l) throw new AppError(404, 'Lot introuvable');
    const delta = newQty - l.quantity;
    if (delta === 0) throw new AppError(400, 'Quantité inchangée');
    await c.query('UPDATE stock_lots SET quantity = $2 WHERE id = $1', [lotId, newQty]);
    await c.query(`INSERT INTO stock_movements (tenant_id, product_id, lot_id, type, quantity, reason, user_id) VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`, [req.user.tenantId, l.product_id, lotId, delta, reason, req.user.id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'stock.adjusted', entity: 'lot', entityId: lotId, meta: { from: l.quantity, to: newQty, reason }, ip: req.ip });
    return { delta };
  });
  res.json(out);
}));

// GET /api/stocks/alerts?days=90
router.get('/alerts', requirePermission('stocks:read'), wrap(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
  const out = await tx(ctx(req), async (c) => {
    const prods = (await c.query(`${PRODUCT_AGG} WHERE p.is_active GROUP BY p.id`)).rows.map(toProduct);
    const lots = (await c.query(
      `SELECT l.id, l.lot_number, l.expiry_date, l.quantity, p.id AS product_id, p.name FROM stock_lots l JOIN products p ON p.id = l.product_id
        WHERE l.quantity > 0 AND p.is_active ORDER BY l.expiry_date LIMIT 500`)).rows;
    const day = today(req.user.timezone);
    const lotAlerts = lots.map((l) => ({ ...l, expiryStatus: expiryStatus(l.expiry_date, day, days) })).filter((l) => l.expiryStatus !== 'ok');
    return {
      outOfStock: prods.filter((p) => p.status === 'rupture').map((p) => ({ id: p.id, name: p.name })),
      low: prods.filter((p) => p.status === 'bas').map((p) => ({ id: p.id, name: p.name, available: p.available, minStock: p.minStock })),
      expiring: lotAlerts.filter((l) => l.expiryStatus === 'proche'), expired: lotAlerts.filter((l) => l.expiryStatus === 'perime'),
      totals: { products: prods.length },
    };
  });
  res.json(out);
}));

module.exports = router;
