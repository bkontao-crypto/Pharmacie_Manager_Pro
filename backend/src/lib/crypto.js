'use strict';
const crypto = require('crypto');

/** Chiffrement AES-256-GCM pour données sensibles (ex. secret TOTP). Clé = 32 octets en hex (64 car.). */
function getKey(hex = process.env.ENCRYPTION_KEY) {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY invalide : 64 caractères hexadécimaux requis (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plain, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(hexKey), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(payload, hexKey) {
  const [v, iv, tag, ct] = String(payload).split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Format chiffré invalide');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(hexKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

/** Mot de passe temporaire lisible, conforme à la politique (lettres + chiffres, 14 car.). */
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${out}${crypto.randomInt(10, 99)}`;
}

module.exports = { encrypt, decrypt, sha256, randomToken, tempPassword };
