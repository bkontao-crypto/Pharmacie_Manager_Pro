'use strict';
/** Base de référence clinique : normalisation/validation des imports (pur) + accès base (client de transaction fourni). */
const { norm } = require('./text');
const { checkAllergies, findInteractions, missingDciAlerts, SEVERITY } = require('./clinical');
const { parseCsv } = require('./csvParse');

const SEVERITY_ALIASES = { contre_indication: 'contre_indication', contre_indique: 'contre_indication', association_deconseillee: 'association_deconseillee', deconseillee: 'association_deconseillee',
  precaution: 'precaution', precaution_d_emploi: 'precaution', a_prendre_en_compte: 'a_prendre_en_compte', prendre_en_compte: 'a_prendre_en_compte' };
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Retourne { ok, value | error }. Les termes sont normalisés et ordonnés (term_a ≤ term_b). */
function normalizeRule(raw) {
  const a = norm(raw.termA ?? raw.terme_a); const b = norm(raw.termB ?? raw.terme_b);
  if (a.length < 2 || b.length < 2 || a.length > 80 || b.length > 80) return { ok: false, error: 'termes A et B requis (2 à 80 caractères)' };
  const sev = SEVERITY_ALIASES[norm(raw.severity ?? raw.gravite).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')];
  if (!sev) return { ok: false, error: `gravité inconnue « ${raw.severity ?? raw.gravite} » (${Object.keys(SEVERITY).join(', ')})` };
  const description = String(raw.description ?? '').trim();
  if (description.length < 3 || description.length > 500) return { ok: false, error: 'description requise (3 à 500 caractères)' };
  const reco = String(raw.recommendation ?? raw.recommandation ?? '').trim().slice(0, 300) || null;
  const [term_a, term_b] = a <= b ? [a, b] : [b, a];
  return { ok: true, value: { term_a, term_b, severity: sev, description, recommendation: reco } };
}
function normalizeClass(raw) {
  const substance = norm(raw.substance); const cls = norm(raw.class ?? raw.classe);
  if (substance.length < 3 || substance.length > 80 || cls.length < 2 || cls.length > 80) return { ok: false, error: 'substance (3+ car.) et classe requises' };
  return { ok: true, value: { substance, class: cls } };
}

/** Importe des règles et classes. tenantId = null → base globale. Les lignes invalides sont ignorées et listées. */
async function importReference(c, { tenantId = null, source, rules = [], classes = [] }) {
  if (rules.length > 5000 || classes.length > 5000) throw new Error('Import limité à 5000 lignes par type');
  const src = String(source || 'import').slice(0, 300); const errors = []; let nr = 0; let nc = 0;
  for (const [i, raw] of rules.entries()) {
    const r = normalizeRule(raw || {}); if (!r.ok) { if (errors.length < 20) errors.push({ kind: 'règle', line: i + 1, message: r.error }); continue; }
    const v = r.value;
    await c.query(`INSERT INTO drug_interactions (tenant_id, term_a, term_b, severity, description, recommendation, source) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (COALESCE(tenant_id, '${NIL_UUID}'::uuid), term_a, term_b) DO UPDATE SET severity = EXCLUDED.severity, description = EXCLUDED.description, recommendation = EXCLUDED.recommendation, source = EXCLUDED.source`,
      [tenantId, v.term_a, v.term_b, v.severity, v.description, v.recommendation, src]); nr++;
  }
  for (const [i, raw] of classes.entries()) {
    const r = normalizeClass(raw || {}); if (!r.ok) { if (errors.length < 20) errors.push({ kind: 'classe', line: i + 1, message: r.error }); continue; }
    await c.query(`INSERT INTO substance_classes (tenant_id, substance, class, source) VALUES ($1,$2,$3,$4)
      ON CONFLICT (COALESCE(tenant_id, '${NIL_UUID}'::uuid), substance, class) DO NOTHING`, [tenantId, r.value.substance, r.value.class, src]); nc++;
  }
  return { rules: nr, classes: nc, errors };
}

/** Corps d'import (JSON ou CSV) → { rules, classes }. */
function parseImportBody(b) {
  if (b.format === 'csv') {
    const rows = parseCsv(b.content);
    return b.kind === 'classes' ? { rules: [], classes: rows } : { rules: rows, classes: [] };
  }
  return { rules: Array.isArray(b.rules) ? b.rules : [], classes: Array.isArray(b.classes) ? b.classes : [] };
}

async function loadReference(c) {
  const rules = (await c.query('SELECT id, term_a, term_b, severity, description, recommendation, source FROM drug_interactions')).rows;
  const classEntries = (await c.query('SELECT substance, class FROM substance_classes')).rows;
  return { rules, classEntries };
}

/** Toutes les alertes cliniques d'une ordonnance : allergies (avec classes), interactions (avec traitements récents), limites de contrôle. */
async function computeAlerts(c, { patientId, allergies, products }) {
  const ref = await loadReference(c);
  const recent = (await c.query(
    `SELECT DISTINCT p.id, p.name, p.dci FROM prescriptions r JOIN prescription_items i ON i.prescription_id = r.id JOIN products p ON p.id = i.product_id
      WHERE r.patient_id = $1 AND r.status = 'dispensed' AND r.dispensed_at > now() - interval '60 days' AND NOT (p.id = ANY($2::uuid[]))`, [patientId, products.map((p) => p.id)])).rows;
  const limits = [];
  if (!ref.rules.length) limits.push({ type: 'no_reference', level: 'info', message: 'Aucune base d\'interactions chargée : les interactions ne sont pas contrôlées (module Intégrations)' });
  if (allergies.length && !ref.classEntries.length) limits.push({ type: 'no_reference', level: 'info', message: 'Aucune classe thérapeutique chargée : une allergie à une famille (ex. pénicillines) n\'est détectée que si le nom ou la DCI correspond' });
  return [...checkAllergies(allergies, products, ref.classEntries), ...findInteractions({ items: products, recent, rules: ref.rules, classEntries: ref.classEntries }), ...missingDciAlerts(products), ...limits];
}

module.exports = { normalizeRule, normalizeClass, importReference, parseImportBody, loadReference, computeAlerts };
