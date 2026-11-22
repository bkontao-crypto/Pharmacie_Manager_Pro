'use strict';
/** Accès base de la fidélité (à appeler dans une transaction). */
async function loyaltyBalance(c, patientId) {
  return (await c.query('SELECT COALESCE(SUM(points), 0)::int AS b FROM loyalty_ledger WHERE patient_id = $1', [patientId])).rows[0].b;
}
async function loyaltySettings(c, tenantId) {
  const r = (await c.query('SELECT * FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  return { enabled: r ? r.loyalty_enabled : false, earnAmount: r ? Number(r.loyalty_earn_amount) : 1000, pointValue: r ? Number(r.loyalty_point_value) : 10, reminderLeadDays: r ? r.reminder_lead_days : 3 };
}
async function addLedger(c, { tenantId, patientId, points, reason, saleId = null, userId = null }) {
  await c.query('INSERT INTO loyalty_ledger (tenant_id, patient_id, points, reason, sale_id, user_id) VALUES ($1,$2,$3,$4,$5,$6)', [tenantId, patientId, points, reason, saleId, userId]);
}
module.exports = { loyaltyBalance, loyaltySettings, addLedger };
