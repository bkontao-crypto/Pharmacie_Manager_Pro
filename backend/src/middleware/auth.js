'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { tx } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const { resolveWorkSite, canManagePatientAccess, UUID_RE } = require('../lib/sites');

const signAccess = (user) =>
  jwt.sign({ sub: user.id, typ: 'access' }, config.jwtSecret, { expiresIn: config.accessTtl, algorithm: 'HS256' });
const signTemp = (user) =>
  jwt.sign({ sub: user.id, typ: '2fa' }, config.jwtSecret, { expiresIn: '5m', algorithm: 'HS256' });
const verifyToken = (token, typ) => {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (p.typ !== typ) throw new Error('type');
    return p;
  } catch {
    throw new AppError(401, 'Session invalide ou expirée', 'TOKEN_INVALID');
  }
};

const TENANT_SQL = `SELECT t.id, t.name, t.status, t.subscription_end, t.timezone, t.parent_id, t.max_subsites, t.group_patient_access,
    COALESCE((SELECT array_agg(m.module_key) FROM tenant_modules m WHERE m.tenant_id = t.id), '{}') AS modules
  FROM tenants t WHERE t.id = $1`;

/**
 * Charge l'utilisateur à CHAQUE requête (droits et modules toujours à jour : désactiver un module
 * ou un compte prend effet immédiatement), vérifie l'abonnement et calcule les droits.
 * En-tête optionnel X-Pharmacy-Id : l'Admin d'une pharmacie principale travaille dans l'une de ses sous-pharmacies
 * (voir lib/sites.js) ; req.user.tenantId désigne alors la sous-pharmacie, tous les modules existants fonctionnent sans changement.
 */
const authenticate = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new AppError(401, 'Authentification requise', 'NO_TOKEN');
  const payload = verifyToken(h.slice(7), 'access');
  const wanted = typeof req.headers['x-pharmacy-id'] === 'string' ? req.headers['x-pharmacy-id'].trim() : '';

  const ctx = await tx({ system: true }, async (c) => {
    const u = (await c.query(
      `SELECT id, tenant_id, email, full_name, role, permissions, is_active, must_change_password, totp_enabled FROM users WHERE id = $1`, [payload.sub])).rows[0];
    if (!u) return null;
    const home = u.tenant_id ? (await c.query(TENANT_SQL, [u.tenant_id])).rows[0] : null;
    const parent = home && home.parent_id ? (await c.query(TENANT_SQL, [home.parent_id])).rows[0] : null;
    const site = home && UUID_RE.test(wanted) && wanted !== home.id ? (await c.query(TENANT_SQL, [wanted])).rows[0] : null;
    return { u, home, parent, site };
  });

  if (!ctx || !ctx.u.is_active) throw new AppError(401, 'Compte inactif ou introuvable', 'TOKEN_INVALID');
  const { u, home } = ctx;
  const w = resolveWorkSite({ ...ctx, wanted });
  req.user = {
    id: u.id, tenantId: w.t ? w.t.id : null, homeTenantId: u.tenant_id, acting: w.acting, actingFrom: w.acting ? u.tenant_id : null,
    patientDataRestricted: w.restricted, isGroupAdmin: w.isGroupAdmin, isSubsite: w.isSubsite, inGroup: !!home && (!!home.parent_id || home.max_subsites > 0), groupMaxSites: w.isGroupAdmin ? home.max_subsites : 0,
    homeTenantName: home ? home.name : null, homeTimezone: home ? home.timezone : 'UTC',
    homeModules: home ? (ctx.parent ? home.modules.filter((m) => ctx.parent.modules.includes(m)) : home.modules) : [],
    email: u.email, fullName: u.full_name, role: u.role,
    mustChangePassword: u.must_change_password, totpEnabled: u.totp_enabled,
    tenantName: w.t ? w.t.name : null, timezone: w.t ? w.t.timezone || 'UTC' : 'UTC', enabledModules: w.mods,
    permissions: w.permissions,
  };
  next();
});

/** Bloque tout sauf le changement de mot de passe tant que must_change_password est vrai. */
const blockIfMustChange = (req, res, next) =>
  req.user.mustChangePassword ? next(new AppError(403, 'Changement de mot de passe requis', 'MUST_CHANGE_PASSWORD')) : next();

const requireSuperadmin = (req, res, next) =>
  req.user.role === 'superadmin' ? next() : next(new AppError(403, 'Accès réservé au Superadmin'));

/** Admin d'une pharmacie principale multi-sites (toujours évalué sur SA pharmacie, même s'il travaille dans une sous-pharmacie). */
const requireGroupAdmin = (req, res, next) =>
  req.user.isGroupAdmin ? next() : next(new AppError(403, 'Accès réservé à l\'Admin d\'une pharmacie multi-sites'));

/** Gérant local d'une sous-pharmacie (voir lib/sites.js : ni l'Admin du groupe, ni le Superadmin). */
const requireLocalManager = (req, res, next) =>
  canManagePatientAccess(req.user) ? next() : next(new AppError(403, 'Réservé au gérant local de la sous-pharmacie'));

const requireTenantUser = (req, res, next) =>
  req.user.tenantId ? next() : next(new AppError(403, 'Accès réservé aux utilisateurs d\'une pharmacie'));

const requirePermission = (perm) => (req, res, next) =>
  req.user.permissions.includes(perm) ? next() : next(new AppError(403, `Permission requise : ${perm}`));

module.exports = { signAccess, signTemp, verifyToken, authenticate, blockIfMustChange, requireSuperadmin, requireGroupAdmin, requireLocalManager, requireTenantUser, requirePermission };
