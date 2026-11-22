'use strict';
/**
 * Pharmacie de travail d'un utilisateur — logique PURE (sans I/O), testable hors base.
 *  - Utilisateur de pharmacie : il travaille dans la sienne.
 *  - Admin d'une pharmacie principale (multi-sites) : peut travailler dans l'une de SES sous-pharmacies (en-tête X-Pharmacy-Id).
 *  - Modules d'une sous-pharmacie = ses modules ∩ ceux de la pharmacie principale ; l'abonnement de la principale s'applique aussi.
 *  - Sans accès patients accordé (par le GÉRANT LOCAL de la sous-pharmacie, jamais par le Superadmin), l'Admin du groupe perd les droits patients/dispensation/CRM et l'encaissement.
 */
const { AppError } = require('./errors');
const { localDate } = require('./tz');
const P = require('./permissions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const siteUsable = (t, now = new Date()) => !!t && t.status === 'active' && !(t.subscription_end && t.subscription_end < localDate(now, t.timezone));
const effectiveModules = (t, owner) => (owner ? t.modules.filter((m) => owner.modules.includes(m)) : t.modules);

/** @param {{u, home, parent, site, wanted}} in  u : compte ; home : sa pharmacie ; parent : principale de home ; site : pharmacie demandée (X-Pharmacy-Id) */
function resolveWorkSite({ u, home, parent = null, site = null, wanted = '', now = new Date() }) {
  if (!home) return { t: null, acting: false, mods: [], permissions: P.effectivePermissions({ role: u.role, permissions: u.permissions, enabledModules: [] }), restricted: false, isGroupAdmin: false, isSubsite: false };
  if (!siteUsable(home, now) || (parent && !siteUsable(parent, now))) throw new AppError(403, 'Abonnement de la pharmacie inactif ou expiré', 'SUBSCRIPTION_INACTIVE');

  let t = home; let owner = parent; let acting = false;
  if (wanted && wanted !== home.id) {
    if (!UUID_RE.test(wanted)) throw new AppError(400, 'Pharmacie invalide');
    // Seul l'Admin de la pharmacie principale peut travailler dans une de SES sous-pharmacies ; réponse identique si elle n'existe pas.
    if (u.role !== 'admin' || !site || site.parent_id !== home.id) throw new AppError(403, 'Pharmacie non accessible', 'SITE_FORBIDDEN');
    if (!siteUsable(site, now)) throw new AppError(403, 'Cette pharmacie est suspendue ou son abonnement a expiré', 'SUBSCRIPTION_INACTIVE');
    t = site; owner = home; acting = true;
  }
  const mods = effectiveModules(t, owner);
  let permissions = P.effectivePermissions({ role: u.role, permissions: u.permissions, enabledModules: mods });
  const restricted = acting && !t.group_patient_access;
  if (restricted) permissions = P.withoutPatientAccess(permissions);
  const isGroupAdmin = u.role === 'admin' && !home.parent_id && home.max_subsites > 0;
  return { t, acting, mods, permissions, restricted, isGroupAdmin, isSubsite: !!t.parent_id };
}

/** Seul un gérant local, dans SA sous-pharmacie et sans être en train d'y « travailler » depuis le groupe, gère l'accès du groupe aux dossiers patients. */
const canManagePatientAccess = (user) => !!user && user.role === 'gerant' && !user.acting && user.isSubsite === true;

module.exports = { UUID_RE, siteUsable, effectiveModules, resolveWorkSite, canManagePatientAccess };
