'use strict';
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { suggestQuantity } = require('../lib/purchasing');
const { receiveLot } = require('../lib/stockOps');
const { toCents, fromCents } = require('../lib/money');
const { compareInvoiceLine } = require('../lib/invoices');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
// Les achats alimentent le stock : le module Stocks doit être activé.
router.use((req, res, next) => (req.user.enabledModules.includes('stocks') ? next() : next(new AppError(409, 'Les achats nécessitent le module Stocks', 'MODULE_DEPENDENCY'))));
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const num = (n) => `CMD-${String(n).padStart(6, '0')}`;
const like = (q) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

/* ---------------- Fournisseurs ---------------- */
const toSupplier = (r) => ({ id: r.id, name: r.name, contactName: r.contact_name, phone: r.phone, email: r.email, address: r.address, isActive: r.is_active });
function parseSupplier(b, partial) {
  const o = {}; const has = (k) => b[k] !== undefined;
  if (!partial || has('name')) o.name = v.str(b.name, { max: 120, field: 'nom' });
  if (has('contactName')) o.contact_name = v.optStr(b.contactName, { max: 120, field: 'contact' });
  if (has('phone')) o.phone = v.optStr(b.phone, { max: 40, field: 'téléphone' });
  if (has('email')) o.email = b.email ? v.email(b.email) : null;
  if (has('address')) o.address = v.optStr(b.address, { max: 200, field: 'adresse' });
  if (has('isActive')) o.is_active = v.bool(b.isActive, 'actif');
  return o;
}
router.get('/suppliers', requirePermission('achats:read'), wrap(async (req, res) => {
  const rows = await tx(ctx(req), async (c) => (await c.query('SELECT * FROM suppliers ORDER BY is_active DESC, lower(name)')).rows);
  res.json({ suppliers: rows.map(toSupplier) });
}));
router.post('/suppliers', requirePermission('achats:write'), wrap(async (req, res) => {
  const o = parseSupplier(req.body || {}, false); const cols = Object.keys(o);
  const row = await tx(ctx(req), async (c) => {
    const r = (await c.query(`INSERT INTO suppliers (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`, [req.user.tenantId, ...cols.map((k) => o[k])])).rows[0];
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'supplier.created', entity: 'supplier', entityId: r.id, meta: { name: o.name }, ip: req.ip });
    return r;
  });
  res.status(201).json({ supplier: toSupplier(row) });
}));
router.patch('/suppliers/:id', requirePermission('achats:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const o = parseSupplier(req.body || {}, true); const cols = Object.keys(o);
  if (!cols.length) throw new AppError(400, 'Aucune modification');
  const row = await tx(ctx(req), async (c) => {
    const r = (await c.query(`UPDATE suppliers SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => o[k])])).rows[0];
    if (!r) throw new AppError(404, 'Fournisseur introuvable');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'supplier.updated', entity: 'supplier', entityId: id, meta: { fields: cols }, ip: req.ip });
    return r;
  });
  res.json({ supplier: toSupplier(row) });
}));

/* ---------------- Aide à la saisie ---------------- */
router.get('/lookup/products', requirePermission('achats:write'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT p.id, p.name, p.dci, p.dosage, p.purchase_price,
            COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.product_id = p.id AND l.expiry_date >= app_today()), 0)::int AS available
       FROM products p WHERE p.is_active AND ($1 = '' OR p.name ILIKE $2 OR p.dci ILIKE $2 OR p.barcode = $1) ORDER BY lower(p.name) LIMIT 20`, [q, like(q)])).rows);
  res.json({ products: rows.map((r) => ({ id: r.id, name: r.name, dci: r.dci, dosage: r.dosage, unitCost: Number(r.purchase_price), available: r.available })) });
}));

/* ---------------- Commandes automatiques (suggestions) ---------------- */
router.get('/suggestions', requirePermission('achats:read'), wrap(async (req, res) => {
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `SELECT p.id, p.name, p.dci, p.min_stock, p.max_stock, p.purchase_price,
            COALESCE((SELECT SUM(l.quantity) FROM stock_lots l WHERE l.product_id = p.id AND l.expiry_date >= app_today()), 0)::int AS available,
            COALESCE((SELECT SUM(i.quantity_ordered - i.quantity_received) FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.order_id
                       WHERE i.product_id = p.id AND o.status IN ('draft','sent','partial')), 0)::int AS on_order
       FROM products p WHERE p.is_active AND p.min_stock > 0 ORDER BY lower(p.name)`)).rows);
  const suggestions = rows.map((r) => ({ id: r.id, name: r.name, dci: r.dci, available: r.available, onOrder: r.on_order, minStock: r.min_stock, maxStock: r.max_stock, unitCost: Number(r.purchase_price),
    quantity: suggestQuantity({ available: r.available, onOrder: r.on_order, min: r.min_stock, max: r.max_stock }) })).filter((r) => r.quantity > 0);
  res.json({ suggestions });
}));

/* ---------------- Commandes ---------------- */
const ORDER_SQL = `SELECT o.*, s.name AS supplier_name,
    COALESCE((SELECT SUM(i.quantity_ordered * i.unit_cost) FROM purchase_order_items i WHERE i.order_id = o.id), 0) AS total,
    COALESCE((SELECT SUM(i.quantity_ordered) FROM purchase_order_items i WHERE i.order_id = o.id), 0)::int AS qty_ordered,
    COALESCE((SELECT SUM(i.quantity_received) FROM purchase_order_items i WHERE i.order_id = o.id), 0)::int AS qty_received
  FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id`;
const toOrder = (r) => ({ id: r.id, number: num(r.number), supplierId: r.supplier_id, supplierName: r.supplier_name, status: r.status, notes: r.notes, total: Number(r.total),
  qtyOrdered: r.qty_ordered, qtyReceived: r.qty_received, createdAt: r.created_at, sentAt: r.sent_at, receivedAt: r.received_at });

router.get('/orders', requirePermission('achats:read'), wrap(async (req, res) => {
  const status = ['draft', 'sent', 'partial', 'received', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const rows = await tx(ctx(req), async (c) => (await c.query(`${ORDER_SQL} WHERE ($1::text IS NULL OR o.status = $1) ORDER BY o.created_at DESC LIMIT 100`, [status])).rows);
  res.json({ orders: rows.map(toOrder) });
}));

router.get('/orders/:id', requirePermission('achats:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const o = (await c.query(`${ORDER_SQL} WHERE o.id = $1`, [id])).rows[0];
    if (!o) throw new AppError(404, 'Commande introuvable');
    const items = (await c.query(`SELECT i.id, i.product_id, p.name, p.dci, i.quantity_ordered, i.quantity_received, i.unit_cost FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 ORDER BY p.name`, [id])).rows;
    return { order: toOrder(o), items: items.map((i) => ({ id: i.id, productId: i.product_id, name: i.name, dci: i.dci, quantityOrdered: i.quantity_ordered, quantityReceived: i.quantity_received, missing: i.quantity_ordered - i.quantity_received, unitCost: Number(i.unit_cost) })) };
  });
  res.json(out);
}));

router.post('/orders', requirePermission('achats:write'), wrap(async (req, res) => {
  const b = req.body || {}; const supplierId = v.uuid(b.supplierId, 'fournisseur');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 200) throw new AppError(400, 'Entre 1 et 200 lignes requises');
  const items = b.items.map((i) => ({ productId: v.uuid(i?.productId, 'produit'), quantity: v.int(i?.quantity, { min: 1, max: 100000, field: 'quantité' }), unitCost: v.money(i?.unitCost ?? 0, 'coût unitaire') }));
  if (new Set(items.map((i) => i.productId)).size !== items.length) throw new AppError(400, 'Un produit apparaît plusieurs fois');
  const notes = v.optStr(b.notes, { max: 500, field: 'notes' });
  const out = await tx(ctx(req), async (c) => {
    if (!(await c.query('SELECT 1 FROM suppliers WHERE id = $1 AND is_active', [supplierId])).rowCount) throw new AppError(404, 'Fournisseur introuvable ou inactif');
    const n = (await c.query('SELECT count(*)::int AS n FROM products WHERE id = ANY($1::uuid[]) AND is_active', [items.map((i) => i.productId)])).rows[0].n;
    if (n !== items.length) throw new AppError(404, 'Produit introuvable ou inactif');
    const o = (await c.query('INSERT INTO purchase_orders (tenant_id, supplier_id, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, number', [req.user.tenantId, supplierId, notes, req.user.id])).rows[0];
    for (const i of items) await c.query('INSERT INTO purchase_order_items (tenant_id, order_id, product_id, quantity_ordered, unit_cost) VALUES ($1,$2,$3,$4,$5)', [req.user.tenantId, o.id, i.productId, i.quantity, i.unitCost]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'order.created', entity: 'order', entityId: o.id, meta: { number: num(o.number), lines: items.length }, ip: req.ip });
    return { id: o.id, number: num(o.number) };
  });
  res.status(201).json(out);
}));

// Envoi au fournisseur = engagement financier → permission distincte « achats:approve »
router.post('/orders/:id/send', requirePermission('achats:approve'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const o = (await c.query('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw new AppError(404, 'Commande introuvable');
    if (o.status !== 'draft') throw new AppError(409, 'Seul un brouillon peut être envoyé');
    await c.query(`UPDATE purchase_orders SET status = 'sent', sent_by = $2, sent_at = now() WHERE id = $1`, [id, req.user.id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'order.sent', entity: 'order', entityId: id, ip: req.ip });
  });
  res.json({ ok: true });
}));

// Réception (totale ou partielle) : crée/alimente les lots, met à jour les manquants et le prix d'achat
router.post('/orders/:id/receive', requirePermission('achats:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {};
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 200) throw new AppError(400, 'Au moins une ligne de réception requise');
  const lines = b.lines.map((l) => ({ itemId: v.uuid(l?.itemId, 'ligne'), quantity: v.int(l?.quantity, { min: 1, max: 100000, field: 'quantité reçue' }), lotNumber: v.str(l?.lotNumber, { max: 60, field: 'n° de lot' }), expiry: v.date(l?.expiryDate, 'péremption') }));
  if (lines.some((l) => !l.expiry)) throw new AppError(400, 'Date de péremption requise sur chaque ligne');
  const out = await tx(ctx(req), async (c) => {
    const o = (await c.query('SELECT number, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw new AppError(404, 'Commande introuvable');
    if (!['sent', 'partial'].includes(o.status)) throw new AppError(409, 'Seule une commande envoyée ou partiellement reçue peut être réceptionnée');
    for (const l of lines) {
      const it = (await c.query('SELECT product_id, quantity_ordered, quantity_received, unit_cost FROM purchase_order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [l.itemId, id])).rows[0];
      if (!it) throw new AppError(404, 'Ligne de commande introuvable');
      if (it.quantity_received + l.quantity > it.quantity_ordered) throw new AppError(409, `Quantité reçue supérieure à la quantité commandée (reste ${it.quantity_ordered - it.quantity_received})`);
      await receiveLot(c, { tenantId: req.user.tenantId, userId: req.user.id, ip: req.ip, productId: it.product_id, lotNumber: l.lotNumber, expiry: l.expiry, qty: l.quantity, reason: `Réception ${num(o.number)}` });
      await c.query('UPDATE purchase_order_items SET quantity_received = quantity_received + $2 WHERE id = $1', [l.itemId, l.quantity]);
      if (Number(it.unit_cost) > 0) await c.query('UPDATE products SET purchase_price = $2 WHERE id = $1', [it.product_id, it.unit_cost]); // les marges suivent le dernier coût d'achat
    }
    const rem = (await c.query('SELECT COALESCE(SUM(quantity_ordered - quantity_received), 0)::int AS missing FROM purchase_order_items WHERE order_id = $1', [id])).rows[0].missing;
    const status = rem === 0 ? 'received' : 'partial';
    await c.query(`UPDATE purchase_orders SET status = $2, received_at = CASE WHEN $2 = 'received' THEN now() ELSE received_at END WHERE id = $1`, [id, status]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'order.received', entity: 'order', entityId: id, meta: { number: num(o.number), lines: lines.length, missing: rem }, ip: req.ip });
    return { status, missing: rem };
  });
  res.json(out);
}));

router.post('/orders/:id/cancel', requirePermission('achats:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const o = (await c.query('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw new AppError(404, 'Commande introuvable');
    if (!['draft', 'sent'].includes(o.status)) throw new AppError(409, 'Une commande partiellement ou totalement reçue ne peut plus être annulée');
    await c.query(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1`, [id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'order.cancelled', entity: 'order', entityId: id, ip: req.ip });
  });
  res.json({ ok: true });
}));

/* ---------------- Contrôle des factures fournisseurs ---------------- */
// Rapproche la facture de ce qui a été commandé (prix) et réellement reçu (quantités)
router.post('/orders/:id/invoices', requirePermission('achats:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {};
  const invoiceNumber = v.str(b.invoiceNumber, { max: 60, field: 'n° de facture' });
  const invoiceDate = v.date(b.invoiceDate, 'date de facture'); if (!invoiceDate) throw new AppError(400, 'Date de facture requise');
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 200) throw new AppError(400, 'Lignes de facture requises');
  const lines = b.lines.map((l) => ({ itemId: v.uuid(l?.itemId, 'ligne'), quantity: v.int(l?.quantity, { min: 0, max: 100000, field: 'quantité facturée' }), unitPrice: v.money(l?.unitPrice, 'prix unitaire facturé') }));
  const out = await tx(ctx(req), async (c) => {
    const o = (await c.query('SELECT number, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!o) throw new AppError(404, 'Commande introuvable');
    if (!['partial', 'received'].includes(o.status)) throw new AppError(409, 'Une facture ne se rapproche que d\'une commande reçue ou partiellement reçue');
    const items = (await c.query('SELECT i.id, p.name, i.quantity_received, i.unit_cost FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = $1', [id])).rows;
    const byId = new Map(items.map((i) => [i.id, i]));
    if (lines.some((l) => !byId.has(l.itemId))) throw new AppError(404, 'Ligne de commande introuvable');
    if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new AppError(400, 'Une ligne apparaît plusieurs fois');
    const missing = items.filter((i) => i.quantity_received > 0 && !lines.some((l) => l.itemId === i.id));
    if (missing.length) throw new AppError(400, `Lignes reçues absentes de la facture : ${missing.map((m) => m.name).join(', ')} (saisir 0 si non facturées)`);
    let total = 0; let expected = 0; let gap = false; const detail = [];
    for (const l of lines) {
      const it = byId.get(l.itemId);
      const cmp = compareInvoiceLine({ receivedQty: it.quantity_received, orderedPrice: Number(it.unit_cost), invoicedQty: l.quantity, invoicedPrice: l.unitPrice });
      total += l.quantity * toCents(l.unitPrice); expected += it.quantity_received * toCents(it.unit_cost); gap = gap || cmp.hasGap;
      detail.push({ itemId: l.itemId, name: it.name, qtyGap: cmp.qtyGap, priceGap: fromCents(cmp.priceGapCents), impact: fromCents(cmp.impactCents) });
    }
    const inv = (await c.query(`INSERT INTO supplier_invoices (tenant_id, order_id, invoice_number, invoice_date, total, expected_total, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.tenantId, id, invoiceNumber, invoiceDate, fromCents(total), fromCents(expected), gap ? 'ecart' : 'conforme', req.user.id])).rows[0];
    for (const [k, l] of lines.entries()) await c.query('INSERT INTO supplier_invoice_lines (tenant_id, invoice_id, item_id, quantity, unit_price, qty_gap, price_gap) VALUES ($1,$2,$3,$4,$5,$6,$7)', [req.user.tenantId, inv.id, l.itemId, l.quantity, l.unitPrice, detail[k].qtyGap, detail[k].priceGap]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: gap ? 'invoice.discrepancy' : 'invoice.checked', entity: 'order', entityId: id, meta: { number: num(o.number), invoiceNumber, total: fromCents(total), expected: fromCents(expected) }, ip: req.ip });
    return { id: inv.id, status: gap ? 'ecart' : 'conforme', total: fromCents(total), expectedTotal: fromCents(expected), gapAmount: fromCents(total - expected), lines: detail.filter((d) => d.qtyGap !== 0 || d.priceGap !== 0) };
  });
  res.status(201).json(out);
}));

router.get('/orders/:id/invoices', requirePermission('achats:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const invs = (await c.query('SELECT id, invoice_number, invoice_date, total, expected_total, status, created_at FROM supplier_invoices WHERE order_id = $1 ORDER BY created_at DESC', [id])).rows;
    const lines = invs.length ? (await c.query(`SELECT l.invoice_id, p.name, l.quantity, l.unit_price, l.qty_gap, l.price_gap FROM supplier_invoice_lines l JOIN purchase_order_items i ON i.id = l.item_id JOIN products p ON p.id = i.product_id WHERE l.invoice_id = ANY($1::uuid[]) ORDER BY p.name`, [invs.map((i) => i.id)])).rows : [];
    return invs.map((i) => ({ id: i.id, invoiceNumber: i.invoice_number, invoiceDate: i.invoice_date, total: Number(i.total), expectedTotal: Number(i.expected_total), gapAmount: Math.round((Number(i.total) - Number(i.expected_total)) * 100) / 100, status: i.status, createdAt: i.created_at,
      gaps: lines.filter((l) => l.invoice_id === i.id && (l.qty_gap !== 0 || Number(l.price_gap) !== 0)).map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: Number(l.unit_price), qtyGap: l.qty_gap, priceGap: Number(l.price_gap) })) }));
  });
  res.json({ invoices: out });
}));

module.exports = router;
