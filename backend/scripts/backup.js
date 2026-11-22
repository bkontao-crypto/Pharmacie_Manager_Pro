'use strict';
/**
 * Sauvegarde chiffrée de la base : pg_dump → AES-256-GCM → fichier local → vérification → rotation → copie distante optionnelle.
 *   npm run backup
 * Variables : DATABASE_URL, BACKUP_ENCRYPTION_KEY (64 hex, DIFFÉRENTE de ENCRYPTION_KEY et conservée HORS du serveur),
 *             BACKUP_DIR (défaut ./backups), BACKUP_KEEP (défaut 14),
 *             BACKUP_UPLOAD_CMD (optionnel, ex. : rclone copy "$BACKUP_FILE" remote:pmp/ — le chemin du fichier est dans $BACKUP_FILE).
 * Planification : cron quotidien, ex. « 30 2 * * * cd /opt/pmp && npm run backup >> backup.log 2>&1 ».
 */
try { require('dotenv').config(); } catch { /* dotenv facultatif : les variables peuvent venir de l'environnement (cron, systemd) */ }
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const B = require('../src/lib/backup');

(async () => {
  const url = process.env.DATABASE_URL; const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!url) throw new Error('DATABASE_URL manquante');
  const dir = path.resolve(process.env.BACKUP_DIR || './backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, B.backupFileName());
  const dump = spawn('pg_dump', ['--format=custom', '--no-owner'], { env: { ...process.env, ...B.pgEnvFromUrl(url) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => { dump.on('error', (e) => reject(new Error(`pg_dump introuvable ou en échec : ${e.message}`))); dump.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump a échoué (code ${code})`)))); });
  try {
    const [size] = await Promise.all([B.encryptToFile(dump.stdout, file, key), exited]);
    const check = await B.verifyBackup(file, key);                      // relit et déchiffre : une sauvegarde non vérifiée n'est pas une sauvegarde
    console.log(`Sauvegarde OK : ${file} (${size} octets chiffrés, ${check.bytes} octets de dump, sha256 ${check.sha256.slice(0, 16)}…)`);
  } catch (e) { try { fs.unlinkSync(file); } catch { /* absent */ } throw e; }
  const removed = B.pruneBackups(dir, Number(process.env.BACKUP_KEEP) || 14);
  if (removed.length) console.log(`Rotation : ${removed.length} ancienne(s) sauvegarde(s) supprimée(s)`);
  if (process.env.BACKUP_UPLOAD_CMD) {
    await new Promise((resolve, reject) => spawn('sh', ['-c', process.env.BACKUP_UPLOAD_CMD], { env: { ...process.env, BACKUP_FILE: file }, stdio: 'inherit' }).on('close', (c) => (c === 0 ? resolve() : reject(new Error(`Copie distante en échec (code ${c})`)))));
    console.log('Copie distante OK');
  } else console.log('Attention : aucune copie distante configurée (BACKUP_UPLOAD_CMD) — une sauvegarde sur le même serveur ne protège pas d\'une perte du serveur.');
})().catch((e) => { console.error(`ÉCHEC DE SAUVEGARDE : ${e.message}`); process.exit(1); });
