'use strict';
const { Pool, types } = require('pg');
// Les colonnes DATE restent des chaînes 'AAAA-MM-JJ' (évite les décalages de fuseau horaire sur péremptions/abonnements)
types.setTypeParser(1082, (v) => v);
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

/**
 * Exécute fn(client) dans une transaction avec le contexte RLS :
 *  - { tenantId }  → l'isolation multi-tenant s'applique (app.tenant_id)
 *  - { timezone } → fuseau IANA de la pharmacie (app.tz) : app_today() / app_date() s'y réfèrent
 *  - { actingFrom } → l'Admin du groupe travaille dans une sous-pharmacie : les audits portent via_group_admin
 *  - { system: true } → contexte système (login, superadmin) : RLS contournée explicitement
 * Les paramètres sont posés en LOCAL (limités à la transaction) → pas de fuite entre requêtes poolées.
 */
async function tx(ctx, fn) {
  const client = await pool.connect();
  client.actingFrom = ctx.actingFrom || null;   // réinitialisé à chaque transaction (clients poolés)
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', $2, true), set_config('app.tz', $3, true)`,
      [ctx.tenantId || '', ctx.system ? 'on' : 'off', ctx.timezone || ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.actingFrom = null;
    client.release();
  }
}

/** Journal d'audit (à appeler dans la même transaction que l'action). */
async function audit(client, { tenantId = null, userId = null, action, entity = null, entityId = null, meta = {}, ip = null }) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, entity, entity_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, userId, action, entity, entityId ? String(entityId) : null, JSON.stringify(client.actingFrom ? { ...meta, via_group_admin: true } : meta), ip],
  );
}

module.exports = { pool, tx, audit };
