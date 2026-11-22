'use strict';
const { toCents } = require('./money');
/** Écarts d'une ligne de facture : quantité (facturé − reçu), prix (facturé − commandé) et impact financier en centimes. */
function compareInvoiceLine({ receivedQty, orderedPrice, invoicedQty, invoicedPrice }) {
  const qtyGap = invoicedQty - receivedQty;
  const priceGapCents = toCents(invoicedPrice) - toCents(orderedPrice);
  const impactCents = invoicedQty * toCents(invoicedPrice) - receivedQty * toCents(orderedPrice);   // >0 : on nous facture trop
  return { qtyGap, priceGapCents, impactCents, hasGap: qtyGap !== 0 || priceGapCents !== 0 };
}
module.exports = { compareInvoiceLine };
