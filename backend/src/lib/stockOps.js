'use strict';
/** Opérations de stock partagées (réception, consommation FEFO, retour). Toujours appelées DANS une transaction. */
const { AppError } = require('./errors');
const { audit } = require('../db');
const { allocateFEFO } = require('./stock');

/** Jour courant dans le fuseau de la pharmacie (posé par tx() ; même référence que app_today() dans les requêtes). */
const dbToday = async (c) => (await c.query('SELECT app_today() AS d')).rows[0].d;

/** Entrée d'un lot (cumule si le n° de lot existe déjà). Retourne l'id du lot. */
async function receiveLot(c, { tenantId, userId, ip, productId, lotNumber, expiry, qty, reason, type = 'reception' }) {
  if (expiry < (await dbToday(c))) throw new AppError(400, 'Réception refusée : lot déjà périmé');
  if (!(await c.query('SELECT 1 FROM products WHERE id = $1 AND is_active', [productId])).rowCount) throw new AppError(404, 'Produit introuvable');
  const ex = (await c.query('SELECT id, expiry_date FROM stock_lots WHERE product_id = $1 AND lot_number = $2 FOR UPDATE', [productId, lotNumber])).rows[0];
  let lotId;
  if (ex) {
    if (ex.expiry_date !== expiry) throw new AppError(409, 'Ce n° de lot existe déjà avec une autre date de péremption');
    await c.query('UPDATE stock_lots SET quantity = quantity + $2 WHERE id = $1', [ex.id, qty]); lotId = ex.id;
  } else {
    lotId = (await c.query('INSERT INTO stock_lots (tenant_id, product_id, lot_number, expiry_date, quantity) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tenantId, productId, lotNumber, expiry, qty])).rows[0].id;
  }
  await c.query(`INSERT INTO stock_movements (tenant_id, product_id, lot_id, type, quantity, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, productId, lotId, type, qty, reason || 'Réception', userId]);
  await audit(c, { tenantId, userId, action: type === 'transfer_in' ? 'stock.transfer_in' : 'stock.received', entity: 'product', entityId: productId, meta: { lotNumber, expiry, qty }, ip });
  return lotId;
}

/** Sort `quantity` unités en FEFO (lots verrouillés). Lève 409 si le stock non périmé est insuffisant. */
async function consumeFEFO(c, { tenantId, userId, productId, productName, quantity, type, reason, refId }) {
  const lots = (await c.query('SELECT id, expiry_date, quantity FROM stock_lots WHERE product_id = $1 AND quantity > 0 ORDER BY expiry_date, id FOR UPDATE', [productId])).rows;
  const { allocations, shortfall } = allocateFEFO(lots, quantity, await dbToday(c));
  if (shortfall > 0) throw new AppError(409, `Stock insuffisant pour « ${productName} » : il manque ${shortfall} unité(s) (lots périmés exclus)`, 'INSUFFICIENT_STOCK');
  for (const a of allocations) {
    await c.query('UPDATE stock_lots SET quantity = quantity - $2 WHERE id = $1', [a.lotId, a.quantity]);
    await c.query(`INSERT INTO stock_movements (tenant_id, product_id, lot_id, type, quantity, reason, ref_id, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, productId, a.lotId, type, -a.quantity, reason, refId || null, userId]);
  }
  return allocations; // [{lotId, quantity}]
}

/** Remet en stock sur les lots d'origine (retour client). */
async function restock(c, { tenantId, userId, productId, lotId, quantity, reason, refId, type = 'return' }) {
  await c.query('UPDATE stock_lots SET quantity = quantity + $2 WHERE id = $1', [lotId, quantity]);
  await c.query(`INSERT INTO stock_movements (tenant_id, product_id, lot_id, type, quantity, reason, ref_id, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, productId, lotId, type, quantity, reason, refId || null, userId]);
}

module.exports = { receiveLot, consumeFEFO, restock };
