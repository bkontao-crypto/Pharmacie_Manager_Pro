'use strict';
/**
 * Cookie du refresh token (cookie de SESSION : effacé à la fermeture du navigateur, comme l'ancien sessionStorage ;
 * l'expiration réelle reste imposée côté serveur) : HttpOnly (illisible par JavaScript, donc par une faille XSS),
 * SameSite=Strict (jamais envoyé depuis un autre site), limité à /api/auth, Secure en production.
 */
const COOKIE_NAME = 'pmp_rt';
const COOKIE_PATH = '/api/auth';

/** Lit un cookie dans l'en-tête Cookie ; retourne null s'il est absent ou mal formé. */
function readCookie(header, name = COOKIE_NAME) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try { return decodeURIComponent(raw) || null; } catch { return null; }
  }
  return null;
}

function serialize(value, { maxAgeSec, secure }) {
  const attrs = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict'];
  if (maxAgeSec !== undefined) attrs.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

const setRefreshCookie = (res, token, { secure }) => res.append('Set-Cookie', serialize(token, { secure }));
const clearRefreshCookie = (res, { secure }) => res.append('Set-Cookie', serialize('', { maxAgeSec: 0, secure }));

module.exports = { COOKIE_NAME, COOKIE_PATH, readCookie, serialize, setRefreshCookie, clearRefreshCookie };
