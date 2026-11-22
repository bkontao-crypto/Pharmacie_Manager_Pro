'use strict';
const { norm } = require('./text');
/** CSV → tableau d'objets (séparateur « ; » ou « , » détecté, guillemets RFC 4180). En-têtes normalisés (accents/espaces → _). */
function parseCsv(text, maxRows = 5000) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const d = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; if (rows.length > maxRows + 1) throw new Error(`Trop de lignes (max ${maxRows})`); }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => norm(h).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
module.exports = { parseCsv };
