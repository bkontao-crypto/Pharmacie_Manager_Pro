'use strict';
/**
 * Restauration : npm run restore -- chemin/pmp-....dump.enc --yes
 * ⚠ Remplace le contenu de la base cible (pg_restore --clean). Toujours tester d'abord sur une base vide de test.
 */
try { require('dotenv').config(); } catch { /* dotenv facultatif : les variables peuvent venir de l'environnement (cron, systemd) */ }
const { spawn } = require('child_process');
const B = require('../src/lib/backup');
(async () => {
  const [file, flag] = process.argv.slice(2);
  if (!file || flag !== '--yes') throw new Error('Usage : npm run restore -- <fichier> --yes   (écrase la base cible)');
  const env = B.pgEnvFromUrl(process.env.DATABASE_URL);
  await B.verifyBackup(file, process.env.BACKUP_ENCRYPTION_KEY);          // refuse de restaurer un fichier altéré
  const pr = spawn('pg_restore', ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--single-transaction', '--dbname', env.PGDATABASE], { env: { ...process.env, ...env }, stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => { pr.on('error', (e) => reject(new Error(`pg_restore introuvable : ${e.message}`))); pr.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`pg_restore a échoué (code ${c}) — la transaction a été annulée`)))); });
  B.decryptFromFile(file, process.env.BACKUP_ENCRYPTION_KEY).pipe(pr.stdin);
  await done; console.log('Restauration terminée.');
})().catch((e) => { console.error(`ÉCHEC : ${e.message}`); process.exit(1); });
