'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const { AppError } = require('./lib/errors');
const { rateLimit } = require('./middleware/rateLimit');

function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // HTTPS obligatoire en production (derrière un reverse proxy : TRUST_PROXY=1)
  if (config.isProd) {
    app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
  }
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: config.isProd,
  }));
  // CORS strict : aucune origine externe autorisée sauf liste explicite CORS_ORIGINS
  app.use(cors({
    origin: (origin, cb) => (!origin || config.corsOrigins.includes(origin) ? cb(null, config.corsOrigins.includes(origin)) : cb(null, false)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, max: Number(process.env.API_RATE_MAX) || 300 }));   // avant l'analyse du corps : on limite aussi les envois volumineux
  // 100 Ko partout, sauf les imports de base de référence (CSV/JSON jusqu'à 3 Mo)
  const small = express.json({ limit: '100kb' }); const big = express.json({ limit: '3mb' });
  const BIG = new Set(['/api/integrations/import', '/api/superadmin/reference/import']);
  app.use((req, res, next) => (BIG.has(req.path) ? big : small)(req, res, next));

  app.get('/api/health', (req, res) => res.json({ status: 'OK', app: 'Pharmacie Manager Pro', version: '0.6.1' }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/superadmin', require('./routes/superadmin'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/groupe', require('./routes/groupe'));
  app.use('/api/site', require('./routes/site'));
  app.use('/api/transferts', require('./routes/transferts'));
  app.use('/api/patients', require('./routes/patients'));
  app.use('/api/stocks', require('./routes/stocks'));
  app.use('/api/dispensation', require('./routes/dispensation'));
  app.use('/api/achats', require('./routes/achats'));
  app.use('/api/ventes', require('./routes/ventes'));
  app.use('/api/rapports', require('./routes/rapports').router);
  app.use('/api/integrations', require('./routes/integrations'));
  app.use('/api/conformite', require('./routes/conformite'));
  app.use('/api/crm', require('./routes/crm'));
  app.use('/api/rh', require('./routes/rh'));
  app.use('/api', (req, res, next) => next(new AppError(404, 'Route introuvable')));

  app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Contenu trop volumineux' });
    if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'JSON invalide' });
    if (err.code === '23505') return res.status(409).json({ error: 'Valeur déjà utilisée (doublon)' });
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.alerts ? { alerts: err.alerts } : {}), ...(err.requiresNote ? { requiresNote: true } : {}) });
    console.error(err); // jamais de détails internes au client
    res.status(500).json({ error: 'Erreur interne du serveur' });
  });
  return app;
}
module.exports = { createApp };
