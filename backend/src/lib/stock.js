'use strict';
/** Logique de stock pure : allocation FEFO (premier périmé, premier sorti) et statuts. */
const { localDate, DEFAULT_TZ } = require('./tz');

/** Jour local (fuseau IANA de la pharmacie, UTC par défaut) au format AAAA-MM-JJ. */
const today = (tz = DEFAULT_TZ, d = new Date()) => localDate(d, tz);

/**
 * Répartit `needed` unités sur les lots non périmés, par date de péremption croissante.
 * @returns {{allocations: {lotId: string, quantity: number}[], shortfall: number}}
 */
function allocateFEFO(lots, needed, day = today()) {
  const usable = lots
    .filter((l) => l.quantity > 0 && String(l.expiry_date).slice(0, 10) >= day)
    .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)) || String(a.id).localeCompare(String(b.id)));
  const allocations = []; let left = needed;
  for (const l of usable) {
    if (left <= 0) break;
    const take = Math.min(l.quantity, left);
    allocations.push({ lotId: l.id, quantity: take }); left -= take;
  }
  return { allocations, shortfall: left };
}

/** 'rupture' | 'bas' (≤ seuil min) | 'ok' */
function stockStatus(total, min) {
  if (total <= 0) return 'rupture';
  if (min > 0 && total <= min) return 'bas';
  return 'ok';
}

/** 'perime' | 'proche' (dans `days` jours) | 'ok' */
function expiryStatus(expiry, day = today(), days = 90) {
  const e = String(expiry).slice(0, 10);
  if (e < day) return 'perime';
  const limit = new Date(`${day}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() + days);
  return e <= limit.toISOString().slice(0, 10) ? 'proche' : 'ok';
}

module.exports = { allocateFEFO, stockStatus, expiryStatus, today };
