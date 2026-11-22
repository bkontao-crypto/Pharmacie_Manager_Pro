'use strict';
const { norm } = require('./text');
const { substancesOf } = require('./substances');
/** Clé d'équivalence : mêmes substances, même dosage, même forme (espaces ignorés). null si la DCI est inconnue. */
function equivalenceKey(p) {
  const subs = substancesOf(p.dci).sort();
  if (!subs.length) return null;
  return `${subs.join('+')}|${norm(p.dosage).replace(/\s/g, '')}|${norm(p.form)}`;
}
const isEquivalent = (a, b) => { const ka = equivalenceKey(a); return ka !== null && ka === equivalenceKey(b) && a.id !== b.id; };
module.exports = { equivalenceKey, isEquivalent };
