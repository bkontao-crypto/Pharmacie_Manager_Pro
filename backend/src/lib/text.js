'use strict';
/** Normalisation de texte clinique : minuscules, sans accents, espaces réduits. */
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Singulier approximatif (« pénicillines » ≙ « pénicilline », « AINS » ≙ « AIN »). */
const stem = (s) => s.replace(/s$/, '');
module.exports = { norm, stem };
