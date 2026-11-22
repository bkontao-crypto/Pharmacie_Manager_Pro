'use strict';
// Vérifie qu'une sauvegarde est lisible et intacte : npm run backup:verify -- chemin/pmp-....dump.enc
try { require('dotenv').config(); } catch { /* dotenv facultatif : les variables peuvent venir de l'environnement (cron, systemd) */ }
const B = require('../src/lib/backup');
(async () => {
  const f = process.argv[2]; if (!f) throw new Error('Usage : npm run backup:verify -- <fichier>');
  const r = await B.verifyBackup(f, process.env.BACKUP_ENCRYPTION_KEY);
  console.log(`Sauvegarde intacte : ${r.bytes} octets de dump, sha256 ${r.sha256}`);
})().catch((e) => { console.error(`SAUVEGARDE INVALIDE : ${e.message}`); process.exit(1); });
