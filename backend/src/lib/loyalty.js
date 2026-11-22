'use strict';
/** Fidélité : calculs en centimes entiers. */
/** Points gagnés sur le montant RÉELLEMENT payé (après remises et points utilisés). */
const earnedPoints = (paidCents, earnAmountCents) => (earnAmountCents > 0 && paidCents > 0 ? Math.floor(paidCents / earnAmountCents) : 0);
const redeemValueCents = (points, pointValueCents) => points * pointValueCents;
/** Maximum utilisable : limité au solde, et la vente doit rester payable (net > 0). */
function maxRedeemablePoints(balance, netCents, pointValueCents) {
  if (balance <= 0 || netCents <= 1 || pointValueCents <= 0) return 0;
  return Math.max(0, Math.min(balance, Math.floor((netCents - 1) / pointValueCents)));
}
module.exports = { earnedPoints, redeemValueCents, maxRedeemablePoints };
