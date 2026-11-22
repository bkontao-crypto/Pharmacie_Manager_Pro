'use strict';
require('dotenv').config();

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name) {
  if (!env[name]) throw new Error(`Variable d'environnement manquante : ${name}`);
  return env[name];
}

const config = {
  isProd,
  port: Number(env.PORT) || 3000,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  encryptionKey: required('ENCRYPTION_KEY'),
  accessTtl: env.ACCESS_TOKEN_TTL || '15m',
  refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS) || 7,
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY === '1',
  maxFailedLogins: 5,
  lockMinutes: 15,
};

if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET trop court (32 caractères minimum)');
module.exports = config;
