'use strict';
/** Rappels de renouvellement : dernière délivrance par (patient, produit) + cycle du produit. */
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * rows : [{ patientId, productId, lastOn: 'AAAA-MM-JJ', renewalDays }] (une ligne par patient/produit, dernière délivrance).
 * Retourne ceux dont le renouvellement tombe au plus tard dans `leadDays` jours, triés par échéance.
 */
function computeDue(rows, today, leadDays = 3) {
  return rows
    .filter((r) => Number.isInteger(r.renewalDays) && r.renewalDays > 0)
    .map((r) => { const dueOn = addDays(r.lastOn, r.renewalDays); return { patientId: r.patientId, productId: r.productId, lastOn: r.lastOn, dueOn, daysLate: diffDays(today, dueOn) }; })
    .filter((r) => r.dueOn <= addDays(today, leadDays))
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.patientId.localeCompare(b.patientId));
}
module.exports = { computeDue, addDays, diffDays };
