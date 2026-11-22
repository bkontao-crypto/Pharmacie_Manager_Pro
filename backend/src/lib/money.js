'use strict';
/** Calculs monétaires en centimes entiers (aucune erreur d'arrondi flottant). */
const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;

/** lines: [{unitPrice, quantity}] — remise en % sur le sous-total. */
function computeTotals(lines, discountPct = 0) {
  const subtotal = lines.reduce((s, l) => s + toCents(l.unitPrice) * l.quantity, 0);
  const discount = Math.round((subtotal * discountPct) / 100);
  return { subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount };
}

/** Le total des paiements doit égaler exactement le total à payer. */
const paymentsTotalCents = (payments) => payments.reduce((s, p) => s + toCents(p.amount), 0);

module.exports = { toCents, fromCents, computeTotals, paymentsTotalCents };
