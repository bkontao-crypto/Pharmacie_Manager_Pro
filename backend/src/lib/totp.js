'use strict';
const crypto = require('crypto');
/** TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s) compatible Google Authenticator / Authy / Microsoft Authenticator. */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx < 0) throw new Error('Base32 invalide');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1e6).padStart(6, '0');
}

const totp = (secretB32, time = Date.now()) => hotp(secretB32, Math.floor(time / 30000));

/** Vérifie un code avec tolérance ±1 pas (dérive d'horloge). Comparaison à temps constant. */
function verify(secretB32, code, time = Date.now(), window = 1) {
  const given = Buffer.from(String(code || '').replace(/\s/g, ''));
  if (given.length !== 6) return false;
  const step = Math.floor(time / 30000);
  let ok = false;
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secretB32, step + w));
    if (crypto.timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

const otpauthUri = (secret, account, issuer = 'Pharmacie Manager Pro') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { generateSecret, totp, verify, otpauthUri, base32Encode, base32Decode };
