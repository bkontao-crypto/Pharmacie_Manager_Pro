'use strict';
/** Transferts de stock entre pharmacies d'un groupe — logique PURE (machine d'états, appariement des produits). */
const { AppError } = require('./errors');

const STATUS_LABEL = { draft: 'Brouillon', in_transit: 'En transit', received: 'Reçu', cancelled: 'Annulé', refused: 'Refusé (à reprendre)', returned: 'Repris par l’expéditeur', received_short: 'Reçu partiellement — écart à reprendre' };

/** Qui peut faire quoi, et depuis quel état. */
const ACTIONS = {
  send:    { from: ['draft'],               to: 'in_transit', side: 'sender' },
  cancel:  { from: ['draft', 'in_transit'], to: 'cancelled',  side: 'sender' },
  receive: { from: ['in_transit'],          to: 'received',   side: 'receiver' },
  refuse:  { from: ['in_transit'],          to: 'refused',    side: 'receiver' },
  // reprise par l'expéditrice : tout le stock d'un transfert refusé, ou seulement l'écart d'une réception partielle (le transfert est alors soldé : « reçu »)
  return:  { from: ['refused', 'received_short'], to: (status) => (status === 'refused' ? 'returned' : 'received'), side: 'sender' },
};

/** Nouveau statut, ou erreur (403 mauvais côté, 409 mauvais état). `side` : 'sender' | 'receiver'. */
function nextStatus(status, action, side) {
  const a = ACTIONS[action];
  if (!a) throw new AppError(400, 'Action inconnue');
  if (a.side !== side) throw new AppError(403, a.side === 'sender' ? 'Seule la pharmacie expéditrice peut faire cette action' : 'Seule la pharmacie destinataire peut faire cette action');
  if (!a.from.includes(status)) throw new AppError(409, `Action impossible : le transfert est « ${STATUS_LABEL[status] || status} »`, 'TRANSFER_STATE');
  return typeof a.to === 'function' ? a.to(status) : a.to;
}

/** 'sender' | 'receiver' | null selon la pharmacie qui agit. */
const sideOf = (t, tenantId) => (t.from_tenant_id === tenantId ? 'sender' : t.to_tenant_id === tenantId ? 'receiver' : null);

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const nameKey = (p) => [norm(p.name ?? p.product_name), norm(p.form), norm(p.dosage)].join('|');

/**
 * Apparie une ligne de transfert avec le catalogue du destinataire : code-barres identique (identité du produit), sinon même
 * nom + forme + dosage (sans casse ni accents). { product } | { product: null } (à créer) | { ambiguous: true } (plusieurs candidats).
 */
function matchProduct(catalog, snap) {
  if (norm(snap.barcode)) {
    const byCode = catalog.filter((c) => norm(c.barcode) === norm(snap.barcode));
    if (byCode.length === 1) return { product: byCode[0] };
    if (byCode.length > 1) return { ambiguous: true };
  }
  const byName = catalog.filter((c) => nameKey(c) === nameKey(snap));
  if (byName.length === 1) return { product: byName[0] };
  if (byName.length > 1) return { ambiguous: true };
  return { product: null };
}

/**
 * Réception, lot par lot. `lots` : [{ id, quantity }] (expédiés) ; `received` : { [lotId]: quantité reçue } (absent = tout reçu ; lot non cité = reçu en entier).
 * Renvoie { items: [{ id, shipped, received, short }], shortfall, status } ; erreur 400 si un lot est inconnu, une quantité invalide
 * (entier de 0 au maximum de l'expédié) ou si rien n'est reçu (dans ce cas : refuser le transfert).
 */
function planReceipt(lots, received) {
  if (received != null && (typeof received !== 'object' || Array.isArray(received))) throw new AppError(400, 'Quantités reçues invalides');
  const known = new Set(lots.map((l) => l.id));
  for (const id of Object.keys(received || {})) if (!known.has(id)) throw new AppError(400, 'Lot inconnu dans ce transfert');
  const items = lots.map((l) => {
    const raw = received && Object.prototype.hasOwnProperty.call(received, l.id) ? received[l.id] : l.quantity;
    if (!Number.isInteger(raw) || raw < 0 || raw > l.quantity) throw new AppError(400, `Quantité reçue invalide (0 à ${l.quantity} attendu)`);
    return { id: l.id, shipped: l.quantity, received: raw, short: l.quantity - raw };
  });
  if (!items.some((i) => i.received > 0)) throw new AppError(400, 'Rien n’est reçu : refusez le transfert avec un motif', 'NOTHING_RECEIVED');
  const shortfall = items.reduce((t, i) => t + i.short, 0);
  return { items, shortfall, status: shortfall > 0 ? 'received_short' : 'received' };
}

const transferNumber = (n) => `TRF-${String(n).padStart(6, '0')}`;

module.exports = { STATUS_LABEL, ACTIONS, nextStatus, sideOf, matchProduct, planReceipt, transferNumber, norm };
