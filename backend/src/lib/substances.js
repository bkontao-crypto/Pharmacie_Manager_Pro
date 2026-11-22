'use strict';
const { norm, stem } = require('./text');

/** « Amoxicilline + acide clavulanique » → ['amoxicilline', 'acide clavulanique'] */
const SPLIT = /\s*(?:\+|\/|,|;|\bet\b|\band\b)\s*/;
const substancesOf = (dci) => [...new Set(norm(dci).split(SPLIT).map((s) => s.trim()).filter((s) => s.length >= 3))];

/** `substance` correspond à `term` : égalité (singulier/pluriel) ou terme en tête (« amoxicilline trihydratee » ⊃ « amoxicilline »). */
function matchesTerm(substance, term) {
  const a = stem(substance); const b = stem(term);
  return a === b || a.startsWith(`${b} `);
}

/** Ensemble des termes d'une substance : elle-même + ses classes (ex. ibuprofène → AINS). */
function termsOfSubstance(substance, classEntries = []) {
  const out = new Set([substance]);
  for (const e of classEntries) if (matchesTerm(substance, e.substance)) out.add(e.class);
  return out;
}
const termsOfProduct = (dci, classEntries = []) => {
  const out = new Set();
  for (const s of substancesOf(dci)) for (const t of termsOfSubstance(s, classEntries)) out.add(t);
  return out;
};
const hasTerm = (terms, term) => { for (const t of terms) if (matchesTerm(t, term)) return true; return false; };

module.exports = { substancesOf, matchesTerm, termsOfProduct, hasTerm };
