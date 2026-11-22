'use strict';
const { AppError } = require('../lib/errors');

/** Limiteur en mémoire (fenêtre fixe). Pour du multi-instance, remplacer par Redis. */
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Trop de requêtes, réessayez plus tard.' }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return next(new AppError(429, message));
    }
    next();
  };
}
module.exports = { rateLimit };
