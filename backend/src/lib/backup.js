'use strict';
/**
 * Sauvegardes chiffrées. Format : "PMPBK1" | IV (12 o) | données chiffrées AES-256-GCM | tag d'authentification (16 o).
 * Le tag final garantit l'intégrité : une sauvegarde altérée est refusée à la lecture.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');

const MAGIC = Buffer.from('PMPBK1'); const IV_LEN = 12; const TAG_LEN = 16; const HEADER = MAGIC.length + IV_LEN;
const NAME_RE = /^pmp-\d{8}T\d{6}Z\.dump\.enc$/;

function keyFrom(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex || '')) throw new Error('BACKUP_ENCRYPTION_KEY invalide : 64 caractères hexadécimaux requis (openssl rand -hex 32)');
  return Buffer.from(hex, 'hex');
}
const backupFileName = (d = new Date()) => `pmp-${d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump.enc`;

async function encryptToFile(readable, destPath, hexKey) {
  const iv = crypto.randomBytes(IV_LEN); const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(hexKey), iv);
  fs.writeFileSync(destPath, Buffer.concat([MAGIC, iv]), { mode: 0o600 });
  await pipeline(readable, cipher, fs.createWriteStream(destPath, { flags: 'a' }));
  fs.appendFileSync(destPath, cipher.getAuthTag());
  return fs.statSync(destPath).size;
}

/** Flux déchiffré ; une altération déclenche une erreur à la fin de la lecture. */
function decryptFromFile(srcPath, hexKey) {
  const size = fs.statSync(srcPath).size;
  if (size < HEADER + TAG_LEN) throw new Error('Fichier de sauvegarde invalide (trop court)');
  const fd = fs.openSync(srcPath, 'r'); const head = Buffer.alloc(HEADER); const tag = Buffer.alloc(TAG_LEN);
  try { fs.readSync(fd, head, 0, HEADER, 0); fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN); } finally { fs.closeSync(fd); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Format de sauvegarde inconnu');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(hexKey), head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const rs = fs.createReadStream(srcPath, { start: HEADER, end: size - TAG_LEN - 1 });
  rs.on('error', (e) => decipher.destroy(e));
  return rs.pipe(decipher);
}

/** Déchiffre entièrement (sans rien écrire) pour prouver que la sauvegarde est lisible et intacte. */
async function verifyBackup(srcPath, hexKey) {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  await pipeline(decryptFromFile(srcPath, hexKey), new Writable({ write(chunk, _e, cb) { hash.update(chunk); bytes += chunk.length; cb(); } }));
  return { bytes, sha256: hash.digest('hex') };
}

/** Garde les `keep` sauvegardes les plus récentes ; retourne les fichiers supprimés. */
function pruneBackups(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse();
  const old = files.slice(Math.max(1, keep)); // on garde toujours au moins 1 fichier
  old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
  return old;
}

/** DATABASE_URL → variables libpq (le mot de passe ne figure ainsi jamais dans la ligne de commande visible par `ps`). */
function pgEnvFromUrl(url) {
  const u = new URL(url);
  const env = { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.replace(/^\//, '') };
  if (u.searchParams.get('sslmode')) env.PGSSLMODE = u.searchParams.get('sslmode');
  return env;
}

module.exports = { encryptToFile, decryptFromFile, verifyBackup, pruneBackups, pgEnvFromUrl, backupFileName, NAME_RE };
