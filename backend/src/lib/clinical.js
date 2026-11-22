'use strict';
/**
 * Contrôles cliniques : allergies et interactions.
 * IMPORTANT : la qualité dépend entièrement de la base de référence chargée (voir module Intégrations).
 * L'outil aide le pharmacien ; il ne remplace ni son analyse ni une base médicamenteuse validée.
 */
const { norm } = require('./text');
const { substancesOf, hasTerm, termsOfProduct } = require('./substances');

const SEVERITY = {
  contre_indication:        { level: 'danger',  rank: 4, label: 'Contre-indication' },
  association_deconseillee: { level: 'danger',  rank: 3, label: 'Association déconseillée' },
  precaution:               { level: 'warning', rank: 2, label: 'Précaution d\'emploi' },
  a_prendre_en_compte:      { level: 'info',    rank: 1, label: 'À prendre en compte' },
};

/** Allergie déclarée ↔ produit (nom, DCI ou classe thérapeutique). */
function checkAllergies(allergies = [], products = [], classEntries = []) {
  const alerts = [];
  for (const raw of allergies) {
    const a = norm(raw);
    if (a.length < 3) continue;
    for (const p of products) {
      const hay = [norm(p.name), norm(p.dci), ...substancesOf(p.dci)].filter(Boolean);
      const direct = hay.some((h) => h.includes(a) || (h.length >= 4 && a.includes(h)));
      if (direct || hasTerm(termsOfProduct(p.dci, classEntries), a)) {
        alerts.push({ type: 'allergy', level: 'danger', productId: p.id, productName: p.name, allergy: raw, message: `Allergie déclarée « ${raw} » : ${p.name}` });
      }
    }
  }
  return alerts;
}

/** DCI manquante = produit non contrôlable : on le dit explicitement plutôt que de laisser croire qu'il n'y a rien. */
const missingDciAlerts = (products) => products.filter((p) => !substancesOf(p.dci).length).map((p) => ({
  type: 'missing_dci', level: 'info', productId: p.id, productName: p.name, message: `DCI non renseignée pour « ${p.name} » : allergies et interactions non contrôlées`,
}));

/**
 * Interactions entre les produits prescrits (items) et avec les traitements récents du patient (recent).
 * Deux traitements récents entre eux ne génèrent pas d'alerte (déjà délivrés).
 */
function findInteractions({ items = [], recent = [], rules = [], classEntries = [] }) {
  const units = [...items.map((p) => ({ ...p, recent: false })), ...recent.map((p) => ({ ...p, recent: true }))].map((u) => ({ ...u, terms: termsOfProduct(u.dci, classEntries) }));
  const alerts = [];
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    const X = units[i]; const Y = units[j];
    if (X.recent && Y.recent) continue;
    for (const r of rules) {
      if (!((hasTerm(X.terms, r.term_a) && hasTerm(Y.terms, r.term_b)) || (hasTerm(X.terms, r.term_b) && hasTerm(Y.terms, r.term_a)))) continue;
      const sev = SEVERITY[r.severity]; if (!sev) continue;
      alerts.push({ type: 'interaction', level: sev.level, rank: sev.rank, severity: r.severity, ruleId: r.id, source: r.source, withRecent: X.recent || Y.recent,
        productIds: [X.id, Y.id], recommendation: r.recommendation || null,
        message: `${sev.label} : ${X.name} + ${Y.name}${X.recent || Y.recent ? ' (traitement récent du patient)' : ''} — ${r.description}` });
    }
  }
  return alerts.sort((a, b) => b.rank - a.rank);
}

module.exports = { checkAllergies, findInteractions, missingDciAlerts, SEVERITY, norm };
