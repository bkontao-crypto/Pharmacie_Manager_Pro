'use strict';
/**
 * Transferts de stock entre pharmacies d'UN MÊME groupe (principale + sous-pharmacies).
 * Brouillon → expédition (stock sorti en FEFO chez l'expéditrice, lots tracés) → réception (mêmes lots chez le destinataire)
 * ou annulation / refus + reprise. Chaque côté agit dans SA transaction et son contexte RLS (tx(ctx(req))) ;
 * seul le contrôle d'appartenance au groupe lit l'autre pharmacie (contexte système, noms et modules uniquement).
 */
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { siteUsable, effectiveModules } = require('../lib/sites');
const { nextStatus, sideOf, matchProduct, planReceipt, transferNumber } = require('../lib/transfers');
const { receiveLot, consumeFEFO, restock } = require('../lib/stockOps');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser);
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
const me = (req) => req.user.tenantId;

const TENANT_SQL = `SELECT t.id, t.name, t.city, t.status, t.subscription_end, t.timezone, t.parent_id,
    COALESCE((SELECT array_agg(m.module_key) FROM tenant_modules m WHERE m.tenant_id = t.id), '{}') AS modules
  FROM tenants t WHERE t.id = ANY($1::uuid[])`;
/** Les pharmacies d'un groupe (principale $1 + ses sous-pharmacies), sauf moi ($2). */
const PEERS_SQL = `SELECT t.id, t.name, t.city, t.status, t.subscription_end, t.timezone, t.parent_id,
    COALESCE((SELECT array_agg(m.module_key) FROM tenant_modules m WHERE m.tenant_id = t.id), '{}') AS modules
  FROM tenants t WHERE (t.id = $1 OR t.parent_id = $1) AND t.id <> $2 ORDER BY (t.parent_id IS NOT NULL), t.name`;

/** L'autre pharmacie est-elle dans MON groupe, active, avec le module Stocks ? Même réponse 404 si elle n'existe pas ou est hors groupe. */
async function peerOf(meId, otherId) {
  return tx({ system: true }, async (c) => {
    const first = (await c.query(TENANT_SQL, [[meId, otherId]])).rows;
    const mine = first.find((t) => t.id === meId); const other = first.find((t) => t.id === otherId);
    if (!mine || !other) throw new AppError(404, 'Pharmacie destinataire introuvable');
    const rootId = (t) => t.parent_id || t.id;
    if (rootId(mine) !== rootId(other)) throw new AppError(404, 'Pharmacie destinataire introuvable');
    const root = (await c.query(TENANT_SQL, [[rootId(other)]])).rows[0];
    const owner = other.parent_id ? root : null;
    if (!siteUsable(other) || !siteUsable(root)) throw new AppError(409, 'La pharmacie destinataire est suspendue ou son abonnement a expiré', 'PEER_INACTIVE');
    if (!effectiveModules(other, owner).includes('stocks')) throw new AppError(409, 'Le module Stocks n’est pas activé dans la pharmacie destinataire', 'PEER_NO_STOCKS');
    return other;
  });
}

const LIST_SQL = `SELECT t.id, t.number, t.status, t.notes, t.refusal_reason, t.created_at, t.sent_at, t.received_at, t.shortfall_units, t.shortfall_settled_at, t.from_tenant_id, t.to_tenant_id,
    (SELECT name FROM tenants f WHERE f.id = t.from_tenant_id) AS from_name, (SELECT name FROM tenants d WHERE d.id = t.to_tenant_id) AS to_name,
    (SELECT count(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS line_count,
    (SELECT COALESCE(SUM(l.quantity), 0)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS units
  FROM stock_transfers t`;
const toTransfer = (r, tenantId) => ({
  id: r.id, number: transferNumber(r.number), status: r.status, notes: r.notes, refusalReason: r.refusal_reason,
  direction: r.from_tenant_id === tenantId ? 'out' : 'in', fromId: r.from_tenant_id, fromName: r.from_name, toId: r.to_tenant_id, toName: r.to_name,
  createdAt: r.created_at, sentAt: r.sent_at, receivedAt: r.received_at, shortfallUnits: r.shortfall_units, shortfallSettledAt: r.shortfall_settled_at, lineCount: r.line_count, units: r.units,
});

// GET /api/transferts/sites — les autres pharmacies du groupe vers lesquelles je peux transférer
router.get('/sites', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const sites = await tx({ system: true }, async (c) => {
    const mine = (await c.query('SELECT id, parent_id FROM tenants WHERE id = $1', [me(req)])).rows[0];
    const rootId = mine.parent_id || mine.id;
    const rows = (await c.query(PEERS_SQL, [rootId, me(req)])).rows;
    const root = (await c.query(TENANT_SQL, [[rootId]])).rows[0];
    return rows.filter((t) => siteUsable(t) && siteUsable(root) && effectiveModules(t, t.parent_id ? root : null).includes('stocks')).map((t) => ({ id: t.id, name: t.name, city: t.city, isMain: !t.parent_id }));
  });
  res.json({ sites });
}));

// GET /api/transferts?direction=in|out
router.get('/', requirePermission('stocks:read'), wrap(async (req, res) => {
  const dir = req.query.direction === 'in' ? 'to_tenant_id' : req.query.direction === 'out' ? 'from_tenant_id' : null;
  const rows = await tx(ctx(req), async (c) => (await c.query(
    `${LIST_SQL} WHERE ($1::text IS NULL OR ($1 = 'from_tenant_id' AND t.from_tenant_id = $2) OR ($1 = 'to_tenant_id' AND t.to_tenant_id = $2)) ORDER BY t.created_at DESC LIMIT 100`, [dir, me(req)])).rows);
  res.json({ transfers: rows.map((r) => toTransfer(r, me(req))) });
}));

// GET /api/transferts/:id
router.get('/:id', requirePermission('stocks:read'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const d = await tx(ctx(req), async (c) => {
    const t = (await c.query(`${LIST_SQL} WHERE t.id = $1`, [id])).rows[0];     // RLS : visible de l'expéditrice ; du destinataire une fois expédié
    if (!t) return null;
    const lines = (await c.query('SELECT id, product_name, dci, form, dosage, quantity, created_product, dest_product_id FROM stock_transfer_lines WHERE transfer_id = $1 ORDER BY lower(product_name)', [id])).rows;
    const lots = (await c.query('SELECT id, line_id, lot_number, expiry_date, quantity, received_quantity FROM stock_transfer_lots WHERE transfer_id = $1 ORDER BY expiry_date, lot_number', [id])).rows;
    return { t, lines, lots };
  });
  if (!d) throw new AppError(404, 'Transfert introuvable');
  res.json({ transfer: toTransfer(d.t, me(req)),
    lines: d.lines.map((l) => ({ id: l.id, productName: l.product_name, dci: l.dci, form: l.form, dosage: l.dosage, quantity: l.quantity, createdProduct: l.created_product })),
    lots: d.lots.map((l) => ({ id: l.id, lineId: l.line_id, lotNumber: l.lot_number, expiryDate: l.expiry_date, quantity: l.quantity, receivedQuantity: l.received_quantity })) });
}));

// POST /api/transferts — brouillon (aucun stock n'est réservé ni déplacé avant l'expédition)
router.post('/', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const b = req.body || {};
  const toId = v.uuid(b.toTenantId, 'pharmacie destinataire');
  if (toId === me(req)) throw new AppError(400, 'Choisissez une autre pharmacie du groupe');
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 50) throw new AppError(400, 'Un transfert compte de 1 à 50 produits');
  const merged = new Map();
  for (const l of b.lines) { const pid = v.uuid(l?.productId, 'produit'); merged.set(pid, (merged.get(pid) || 0) + v.int(l?.quantity, { min: 1, max: 100000, field: 'quantité' })); }
  const notes = v.optStr(b.notes, { max: 300, field: 'note' });
  const dest = await peerOf(me(req), toId);
  const t = await tx(ctx(req), async (c) => {
    const ids = [...merged.keys()];
    const prods = (await c.query('SELECT id, name, dci, barcode, form, dosage, requires_prescription, sale_price, purchase_price, is_controlled FROM products WHERE id = ANY($1::uuid[]) AND is_active', [ids])).rows;
    if (prods.length !== ids.length) throw new AppError(404, 'Produit introuvable');
    const ctrl = prods.find((p) => p.is_controlled);
    if (ctrl) throw new AppError(409, `« ${ctrl.name} » est un produit à registre : il ne peut pas être transféré par cette fonction`, 'CONTROLLED_PRODUCT');
    const tr = (await c.query('INSERT INTO stock_transfers (from_tenant_id, to_tenant_id, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, number', [me(req), toId, notes, req.user.id])).rows[0];
    for (const p of prods) {
      await c.query(`INSERT INTO stock_transfer_lines (transfer_id, from_tenant_id, to_tenant_id, product_id, product_name, dci, barcode, form, dosage, requires_prescription, sale_price, purchase_price, quantity)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [tr.id, me(req), toId, p.id, p.name, p.dci, p.barcode, p.form, p.dosage, p.requires_prescription, p.sale_price, p.purchase_price, merged.get(p.id)]);
    }
    await audit(c, { tenantId: me(req), userId: req.user.id, action: 'transfer.created', entity: 'transfer', entityId: tr.id, meta: { number: transferNumber(tr.number), to: dest.name, products: prods.length }, ip: req.ip });
    return tr;
  });
  res.status(201).json({ transfer: { id: t.id, number: transferNumber(t.number) } });
}));

const lockTransfer = async (c, id) => (await c.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [id])).rows[0];
const sideOrFail = (t, req) => { const s = t && sideOf(t, me(req)); if (!s) throw new AppError(404, 'Transfert introuvable'); return s; };

/** Remet en stock, sur les lots d'origine, tout ce qui avait été expédié — ou seulement l'écart d'une réception partielle. */
async function restockShipped(c, req, t, label, onlyShortfall = false) {
  const rows = (await c.query(`SELECT tl.source_lot_id, tl.quantity, tl.received_quantity, l.product_id FROM stock_transfer_lots tl JOIN stock_transfer_lines l ON l.id = tl.line_id WHERE tl.transfer_id = $1`, [t.id])).rows;
  for (const r of rows) {
    const qty = onlyShortfall ? r.quantity - (r.received_quantity ?? r.quantity) : r.quantity;
    if (qty > 0) await restock(c, { tenantId: me(req), userId: req.user.id, productId: r.product_id, lotId: r.source_lot_id, quantity: qty, reason: `${label} ${transferNumber(t.number)}`, refId: t.id, type: 'transfer_return' });
  }
}
const close = (c, id, status, userId) => c.query('UPDATE stock_transfers SET status = $2, closed_by = $3, closed_at = now() WHERE id = $1', [id, status, userId]);
const tAudit = (c, req, t, action, meta = {}) => audit(c, { tenantId: me(req), userId: req.user.id, action, entity: 'transfer', entityId: t.id, meta: { number: transferNumber(t.number), ...meta }, ip: req.ip });

// POST /api/transferts/:id/send — expéditrice : le stock sort (FEFO) et part « en transit »
router.post('/:id/send', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const pre = await tx(ctx(req), async (c) => (await c.query('SELECT to_tenant_id FROM stock_transfers WHERE id = $1 AND from_tenant_id = $2', [id, me(req)])).rows[0]);
  if (!pre) throw new AppError(404, 'Transfert introuvable');
  const dest = await peerOf(me(req), pre.to_tenant_id);          // revérifié à l'envoi : groupe, abonnement, module Stocks
  await tx(ctx(req), async (c) => {
    const t = await lockTransfer(c, id); const side = sideOrFail(t, req);
    nextStatus(t.status, 'send', side);
    const lines = (await c.query(`SELECT l.id, l.product_id, l.quantity, p.name, p.dci, p.barcode, p.form, p.dosage, p.requires_prescription, p.sale_price, p.purchase_price, p.is_active, p.is_controlled
                                    FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id WHERE l.transfer_id = $1 ORDER BY lower(p.name)`, [id])).rows;
    for (const l of lines) {
      if (!l.is_active) throw new AppError(409, `« ${l.name} » n’est plus actif`);
      if (l.is_controlled) throw new AppError(409, `« ${l.name} » est un produit à registre : il ne peut pas être transféré par cette fonction`, 'CONTROLLED_PRODUCT');
      await c.query('UPDATE stock_transfer_lines SET product_name = $2, dci = $3, barcode = $4, form = $5, dosage = $6, requires_prescription = $7, sale_price = $8, purchase_price = $9 WHERE id = $1',
        [l.id, l.name, l.dci, l.barcode, l.form, l.dosage, l.requires_prescription, l.sale_price, l.purchase_price]);
      const used = await consumeFEFO(c, { tenantId: me(req), userId: req.user.id, productId: l.product_id, productName: l.name, quantity: l.quantity, type: 'transfer_out', reason: `Transfert ${transferNumber(t.number)} → ${dest.name}`, refId: id });
      for (const a of used) {
        const lot = (await c.query('SELECT lot_number, expiry_date FROM stock_lots WHERE id = $1', [a.lotId])).rows[0];
        await c.query('INSERT INTO stock_transfer_lots (transfer_id, line_id, from_tenant_id, to_tenant_id, source_lot_id, lot_number, expiry_date, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, l.id, t.from_tenant_id, t.to_tenant_id, a.lotId, lot.lot_number, lot.expiry_date, a.quantity]);
      }
    }
    await c.query(`UPDATE stock_transfers SET status = 'in_transit', sent_by = $2, sent_at = now() WHERE id = $1`, [id, req.user.id]);
    await tAudit(c, req, t, 'transfer.sent', { to: dest.name, products: lines.length });
  });
  res.json({ ok: true });
}));

// POST /api/transferts/:id/cancel — expéditrice : brouillon ou en transit (le stock revient sur les lots d'origine)
router.post('/:id/cancel', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const t = await lockTransfer(c, id); const side = sideOrFail(t, req);
    const next = nextStatus(t.status, 'cancel', side);
    if (t.status === 'in_transit') await restockShipped(c, req, t, 'Annulation du transfert');
    await close(c, id, next, req.user.id);
    await tAudit(c, req, t, 'transfer.cancelled', { wasInTransit: t.status === 'in_transit' });
  });
  res.json({ ok: true });
}));

// POST /api/transferts/:id/receive — destinataire : mêmes lots et péremptions chez lui (quantités reçues lot par lot, écart éventuel repris ensuite par l'expéditrice) ; produit créé s'il est absent du catalogue
router.post('/:id/receive', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  const out = await tx(ctx(req), async (c) => {
    const t = await lockTransfer(c, id); const side = sideOrFail(t, req);
    nextStatus(t.status, 'receive', side);
    const fromName = (await c.query('SELECT name FROM tenants WHERE id = $1', [t.from_tenant_id])).rows[0].name;
    const lines = (await c.query('SELECT * FROM stock_transfer_lines WHERE transfer_id = $1 ORDER BY lower(product_name)', [id])).rows;
    const lots = (await c.query('SELECT * FROM stock_transfer_lots WHERE transfer_id = $1 ORDER BY expiry_date, lot_number', [id])).rows;
    const catalog = (await c.query('SELECT id, name, barcode, form, dosage, is_active FROM products')).rows;
    const plan = planReceipt(lots, req.body?.received);                     // quantités reçues lot par lot ; 400 si invalides ou si rien n'est reçu
    const got = new Map(plan.items.map((i) => [i.id, i.received]));
    let created = 0;
    for (const l of lines) {
      const arriving = lots.filter((x) => x.line_id === l.id && got.get(x.id) > 0);
      if (!arriving.length) continue;                                         // rien reçu pour cette ligne : aucun produit créé
      const m = matchProduct(catalog, l);
      if (m.ambiguous) throw new AppError(409, `Plusieurs produits de votre catalogue correspondent à « ${l.product_name} » : précisez ou fusionnez-les avant de réceptionner`, 'PRODUCT_AMBIGUOUS');
      let pid; let isNew = false;
      if (m.product) {
        if (!m.product.is_active) throw new AppError(409, `« ${m.product.name} » est désactivé dans votre catalogue : réactivez-le avant de réceptionner`, 'PRODUCT_INACTIVE');
        pid = m.product.id;
      } else {
        pid = (await c.query(`INSERT INTO products (tenant_id, name, dci, barcode, form, dosage, sale_price, purchase_price, requires_prescription) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [me(req), l.product_name, l.dci, l.barcode, l.form, l.dosage, l.sale_price, l.purchase_price, l.requires_prescription])).rows[0].id;
        catalog.push({ id: pid, name: l.product_name, barcode: l.barcode, form: l.form, dosage: l.dosage, is_active: true });
        isNew = true; created += 1;
      }
      await c.query('UPDATE stock_transfer_lines SET dest_product_id = $2, created_product = $3 WHERE id = $1', [l.id, pid, isNew]);
      for (const lot of arriving) {
        await receiveLot(c, { tenantId: me(req), userId: req.user.id, ip: req.ip, productId: pid, lotNumber: lot.lot_number, expiry: lot.expiry_date, qty: got.get(lot.id), reason: `Transfert ${transferNumber(t.number)} de ${fromName}`, type: 'transfer_in' });
      }
    }
    for (const i of plan.items) await c.query('UPDATE stock_transfer_lots SET received_quantity = $2 WHERE id = $1', [i.id, i.received]);
    await c.query('UPDATE stock_transfers SET status = $2, received_by = $3, received_at = now(), shortfall_units = $4 WHERE id = $1', [id, plan.status, req.user.id, plan.shortfall]);
    await tAudit(c, req, t, 'transfer.received', { from: fromName, products: lines.length, createdProducts: created, shortfallUnits: plan.shortfall });
    return { createdProducts: created, shortfall: plan.shortfall, status: plan.status };
  });
  res.json({ ok: true, ...out });
}));

// POST /api/transferts/:id/refuse — destinataire : le stock reste « en transit » jusqu'à la reprise par l'expéditrice
router.post('/:id/refuse', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const reason = v.str(req.body?.reason, { max: 300, field: 'motif' });
  await tx(ctx(req), async (c) => {
    const t = await lockTransfer(c, id); const side = sideOrFail(t, req);
    const next = nextStatus(t.status, 'refuse', side);
    await c.query('UPDATE stock_transfers SET status = $2, closed_by = $3, closed_at = now(), refusal_reason = $4 WHERE id = $1', [id, next, req.user.id, reason]);
    await tAudit(c, req, t, 'transfer.refused', { reason });
  });
  res.json({ ok: true });
}));

// POST /api/transferts/:id/return — expéditrice : reprise du stock d'un transfert refusé, ou de l'écart d'une réception partielle
router.post('/:id/return', requirePermission('stocks:transfer'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id);
  await tx(ctx(req), async (c) => {
    const t = await lockTransfer(c, id); const side = sideOrFail(t, req);
    const next = nextStatus(t.status, 'return', side);
    const partial = t.status === 'received_short';                           // réception partielle : seul l'écart revient ; le transfert est alors soldé
    await restockShipped(c, req, t, partial ? 'Reprise de l’écart du transfert' : 'Reprise du transfert refusé', partial);
    await c.query('UPDATE stock_transfers SET status = $2, closed_by = $3, closed_at = now(), shortfall_settled_at = CASE WHEN $4::boolean THEN now() ELSE shortfall_settled_at END WHERE id = $1', [id, next, req.user.id, partial]);
    await tAudit(c, req, t, 'transfer.returned', partial ? { shortfallUnits: t.shortfall_units } : {});
  });
  res.json({ ok: true });
}));

module.exports = router;
