'use strict';
/**
 * Applique les schémas (idempotents) puis le catalogue des modules.
 * À exécuter avec le rôle PROPRIÉTAIRE de la base : MIGRATE_DATABASE_URL (sinon DATABASE_URL).
 * Le rôle de l'application (DATABASE_URL) n'a volontairement aucun droit de modification du schéma.
 */
try { require('dotenv').config(); } catch { /* dotenv facultatif */ }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { MODULES } = require('../src/lib/permissions');

const FILES = ['schema.sql', 'schema_phase2.sql', 'schema_phase3.sql', 'schema_phase4.sql', 'schema_phase5.sql', 'schema_phase6.sql', 'schema_phase7.sql', 'schema_phase8.sql', 'schema_phase9.sql'];

async function run(url) {
  if (!url) throw new Error('MIGRATE_DATABASE_URL ou DATABASE_URL manquante');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    for (const f of FILES) await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8')); // un fichier = une transaction implicite
    for (const m of MODULES) {
      await pool.query(
        `INSERT INTO modules (key, label, description, is_core, sort_order) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, is_core = EXCLUDED.is_core, sort_order = EXCLUDED.sort_order`,
        [m.key, m.label, m.description, m.is_core, m.sort_order]);
    }
  } finally { await pool.end(); }
}
module.exports = { run, FILES };

if (require.main === module) {
  run(process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL)
    .then(() => console.log('Migration OK — schémas et catalogue des modules à jour.'))
    .catch((e) => { console.error(`ÉCHEC DE MIGRATION : ${e.message}`); process.exit(1); });
}
