'use strict';
/**
 * Catalogue des modules/permissions et calcul des droits effectifs.
 * Fichier pur (sans I/O) : entièrement testable hors base de données.
 *
 * Droits effectifs d'un utilisateur local =
 *   (permissions du rôle ∪ permissions additionnelles accordées)
 *   ∩ permissions des modules ACTIVÉS pour la pharmacie
 * Les permissions "core" (gestion utilisateurs, audit) sont réservées à l'Admin.
 */

const MODULES = [
  { key: 'core',         label: 'Socle & Utilisateurs', is_core: true,  sort_order: 0,  description: 'Authentification, utilisateurs, audit (toujours actif)', actions: ['users:read', 'users:write', 'audit:read'] },
  { key: 'patients',     label: 'Patients',             is_core: false, sort_order: 1,  description: 'Dossiers patients, allergies, historique', actions: ['patients:read', 'patients:write', 'patients:delete'] },
  { key: 'dispensation', label: 'Dispensation',         is_core: false, sort_order: 2,  description: 'Ordonnances, interactions, validation', actions: ['dispensation:read', 'dispensation:write', 'dispensation:validate'] },
  { key: 'stocks',       label: 'Stocks & Inventaire',  is_core: false, sort_order: 3,  description: 'Stocks, lots, péremptions, inventaires', actions: ['stocks:read', 'stocks:write', 'stocks:adjust', 'stocks:transfer'] },
  { key: 'achats',       label: 'Achats & Fournisseurs',is_core: false, sort_order: 4,  description: 'Fournisseurs, commandes, réceptions', actions: ['achats:read', 'achats:write', 'achats:approve'] },
  { key: 'ventes',       label: 'Ventes & Caisse',      is_core: false, sort_order: 5,  description: 'POS, facturation, tiers-payant', actions: ['ventes:read', 'ventes:write', 'ventes:refund'] },
  { key: 'rapports',     label: 'Rapports & Pilotage',  is_core: false, sort_order: 6,  description: 'Tableaux de bord, statistiques, exports', actions: ['rapports:read', 'rapports:export'] },
  { key: 'rh',           label: 'RH & Planning',        is_core: false, sort_order: 7,  description: 'Plannings, gardes, présences', actions: ['rh:read', 'rh:write'] },
  { key: 'crm',          label: 'CRM & Fidélité',       is_core: false, sort_order: 8,  description: 'Fidélité, rappels, entretiens', actions: ['crm:read', 'crm:write'] },
  { key: 'conformite',   label: 'Conformité & Traçabilité', is_core: false, sort_order: 10, description: 'Rappels de lots, registre des produits contrôlés', actions: ['conformite:read', 'conformite:export'] },
  { key: 'integrations', label: 'Intégrations',         is_core: false, sort_order: 9,  description: 'Base médicaments, API fournisseurs', actions: ['integrations:read', 'integrations:write'] },
];

const MODULE_KEYS = MODULES.map((m) => m.key);
const PERMISSIONS_BY_MODULE = Object.fromEntries(MODULES.map((m) => [m.key, m.actions]));
const ALL_PERMISSIONS = MODULES.flatMap((m) => m.actions);
const CORE_PERMISSIONS = PERMISSIONS_BY_MODULE.core;

const LOCAL_ROLES = ['admin', 'gerant', 'pharmacien', 'preparateur', 'caissier', 'personnalise'];
const ASSIGNABLE_ROLES = ['gerant', 'pharmacien', 'preparateur', 'caissier', 'personnalise']; // jamais un autre admin ; la hiérarchie ci-dessous filtre selon l'acteur

/** Hiérarchie : on ne crée, ne modifie ni ne réinitialise que des comptes de rang STRICTEMENT inférieur au sien. */
const ROLE_RANK = { superadmin: 100, admin: 30, gerant: 20, pharmacien: 10, preparateur: 10, caissier: 10, personnalise: 10 };
const rankOf = (role) => ROLE_RANK[role] || 0;
const canManageRole = (actorRole, targetRole) => rankOf(actorRole) > rankOf(targetRole);
const assignableRolesFor = (actorRole) => ASSIGNABLE_ROLES.filter((r) => canManageRole(actorRole, r));

const ROLE_DEFAULTS = {
  pharmacien: [
    'patients:read', 'patients:write', 'dispensation:read', 'dispensation:write', 'dispensation:validate',
    'stocks:read', 'stocks:write', 'stocks:transfer', 'ventes:read', 'ventes:write', 'rapports:read', 'crm:read', 'crm:write', 'conformite:read',
  ],
  preparateur: ['patients:read', 'patients:write', 'dispensation:read', 'dispensation:write', 'stocks:read', 'stocks:write'],
  caissier: ['ventes:read', 'ventes:write', 'patients:read', 'stocks:read'],
  personnalise: [],
};

const ROLE_LABELS = {
  superadmin: 'Superadmin', admin: 'Admin Pharmacie', gerant: 'Gérant local', pharmacien: 'Pharmacien',
  preparateur: 'Préparateur', caissier: 'Caissier', personnalise: 'Personnalisé',
};

/** Permissions disponibles pour une pharmacie selon ses modules activés ('core' toujours inclus). */
function permissionsForModules(enabledModules) {
  const enabled = new Set(['core', ...enabledModules]);
  return MODULES.filter((m) => enabled.has(m.key)).flatMap((m) => m.actions);
}

/** Droits effectifs d'un utilisateur. Le superadmin n'a pas de droits "tenant" (il passe par /superadmin). */
function effectivePermissions({ role, permissions = [], enabledModules = [] }) {
  if (role === 'superadmin') return [];
  const allowed = new Set(permissionsForModules(enabledModules));
  if (role === 'admin') return [...allowed];
  // Gérant local : tous les modules activés de SA pharmacie + gestion des comptes de rang inférieur ; ni journal d'audit, ni autre pharmacie
  if (role === 'gerant') return [...allowed].filter((p) => p !== 'audit:read');
  const wanted = new Set([...(ROLE_DEFAULTS[role] || []), ...permissions]);
  return [...wanted].filter((p) => allowed.has(p) && !CORE_PERMISSIONS.includes(p));
}

/** Modules dont les données identifient des patients (dossiers, ordonnances, fidélité/rappels). */
const PATIENT_DATA_MODULES = ['patients', 'dispensation', 'crm'];
/**
 * Droits d'un Admin de groupe qui travaille dans une sous-pharmacie SANS accès aux dossiers patients accordé :
 * plus aucun droit sur les modules patients/dispensation/CRM, et pas d'encaissement ni de remboursement
 * (pilotage seulement : la lecture des ventes reste possible, sans nom de patient).
 */
const withoutPatientAccess = (perms) => perms.filter((p) => !PATIENT_DATA_MODULES.includes(p.split(':')[0]) && !['ventes:write', 'ventes:refund'].includes(p));

/** Retourne les permissions demandées que le donneur d'accès n'a pas le droit d'accorder. */
function invalidGrants(grantorPermissions, requested) {
  const grantor = new Set(grantorPermissions);
  return requested.filter(
    (p) => !ALL_PERMISSIONS.includes(p) || CORE_PERMISSIONS.includes(p) || !grantor.has(p),
  );
}

module.exports = {
  MODULES, MODULE_KEYS, ALL_PERMISSIONS, CORE_PERMISSIONS, PERMISSIONS_BY_MODULE,
  LOCAL_ROLES, ASSIGNABLE_ROLES, ROLE_DEFAULTS, ROLE_LABELS, ROLE_RANK, rankOf, canManageRole, assignableRolesFor,
  PATIENT_DATA_MODULES, withoutPatientAccess,
  permissionsForModules, effectivePermissions, invalidGrants,
};
