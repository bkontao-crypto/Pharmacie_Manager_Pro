'use strict';
/**
 * Fuseaux horaires par pharmacie (noms IANA : « Africa/Bamako », « Africa/Douala »…).
 * Toute notion de « jour » (rapports, caisse, pointage, péremption, abonnement) se calcule dans le fuseau
 * de la pharmacie ; les instants restent stockés en UTC (timestamptz).
 */
const { AppError } = require('./errors');

const DEFAULT_TZ = 'UTC';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;   // refuse « +01:00 » et toute forme non IANA

/** Nom canonique du fuseau, ou null s'il est inconnu. */
function normalizeTimezone(tz) {
  if (typeof tz !== 'string') return null;
  const t = tz.trim();
  if (!t || t.length > 64 || !NAME_RE.test(t)) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: t }).resolvedOptions().timeZone; } catch { return null; }
}
const isValidTimezone = (tz) => normalizeTimezone(tz) !== null;

const cache = new Map();
function parts(d, tz) {
  let f = cache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); cache.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
const safe = (tz) => (isValidTimezone(tz) ? tz : DEFAULT_TZ);

/** Jour local AAAA-MM-JJ d'un instant. */
function localDate(d = new Date(), tz = DEFAULT_TZ) { const p = parts(new Date(d), safe(tz)); return `${p.year}-${p.month}-${p.day}`; }
/** Date et heure locales « AAAA-MM-JJ HH:MM:SS » d'un instant. */
function localDateTime(d, tz = DEFAULT_TZ) { const p = parts(new Date(d), safe(tz)); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; }

/** Nom IANA normalisé, ou erreur 400. */
function requireTimezone(x) {
  const t = normalizeTimezone(x);
  if (!t) throw new AppError(400, 'Fuseau horaire invalide (nom IANA, ex. Africa/Bamako)');
  return t;
}
/** Le nom doit aussi être connu de PostgreSQL (tzdata de la base). */
async function assertKnownToDb(c, t) {
  if (!(await c.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [t])).rowCount) throw new AppError(400, 'Fuseau horaire inconnu de la base de données');
}

module.exports = { DEFAULT_TZ, normalizeTimezone, isValidTimezone, localDate, localDateTime, requireTimezone, assertKnownToDb };
