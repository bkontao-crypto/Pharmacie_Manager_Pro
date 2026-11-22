'use strict';
/**
 * Suggestion de réapprovisionnement : on commande quand (stock + déjà commandé) ≤ seuil min,
 * pour revenir au seuil max (ou 2 × seuil min si aucun max n'est défini).
 */
function suggestQuantity({ available, onOrder = 0, min, max }) {
  if (!min || min <= 0) return 0;                 // pas de seuil → pas de suggestion automatique
  const position = available + onOrder;
  if (position > min) return 0;
  const target = max && max > min ? max : min * 2;
  return Math.max(0, target - position);
}
module.exports = { suggestQuantity };
