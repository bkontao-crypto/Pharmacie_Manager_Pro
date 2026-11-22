'use strict';
/** Cellule CSV sûre : neutralise l'injection de formules (=, +, -, @) et échappe « ; », guillemets et sauts de ligne. */
function csvCell(x) {
  let s = x == null ? '' : String(x);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
module.exports = { csvCell };
