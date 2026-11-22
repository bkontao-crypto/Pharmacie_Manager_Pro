'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { tempPassword } = require('../lib/crypto');
const P = require('../lib/permissions');
const { authenticate, blockIfMustChange, requireTenantUser, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ctx = (req) => ({ tenantId: req.user.tenantId, timezone: req.user.timezone, actingFrom: req.user.actingFrom });
router.use(authenticate, blockIfMustChange, requireTenantUser);

const COLS = 'id, email, full_name, role, permissions, is_active, totp_enabled, last_login_at, created_at, must_change_password';
const present = (u, mods) => ({
  ...u, effectivePermissions: P.effectivePermissions({ role: u.role, permissions: u.permissions, enabledModules: mods }),
});

// GET /api/users/catalog — modules activés, permissions accordables, rôles
router.get('/catalog', requirePermission('users:read'), (req, res) => {
  const enabled = req.user.enabledModules;
  res.json({
    roles: P.assignableRolesFor(req.user.role).map((r) => ({ key: r, label: P.ROLE_LABELS[r], defaults: P.effectivePermissions({ role: r, enabledModules: enabled }) })),
    modules: P.MODULES.filter((m) => !m.is_core && enabled.includes(m.key)).map((m) => ({ key: m.key, label: m.label, permissions: m.actions })),
  });
});

// GET /api/users
router.get('/', requirePermission('users:read'), wrap(async (req, res) => {
  const rows = await tx(ctx(req), async (c) => (await c.query(`SELECT ${COLS} FROM users ORDER BY created_at DESC`)).rows);
  res.json({ users: rows.map((u) => present(u, req.user.enabledModules)) });
}));

// POST /api/users — création d'un employé (droits limités à ceux de l'Admin et aux modules activés)
router.post('/', requirePermission('users:write'), wrap(async (req, res) => {
  const b = req.body || {};
  const email = v.email(b.email);
  const fullName = v.str(b.fullName, { max: 120, field: 'nom complet' });
  const role = v.oneOf(b.role, P.assignableRolesFor(req.user.role), 'rôle');   // uniquement des rôles de rang inférieur au vôtre
  const extra = b.permissions === undefined ? [] : v.stringArray(b.permissions, 'permissions');
  const bad = P.invalidGrants(req.user.permissions, extra);
  if (bad.length) throw new AppError(403, `Permissions non accordables (module non activé ou réservé) : ${bad.join(', ')}`);
  const pwd = b.password ? v.password(b.password) : tempPassword();

  // l'unicité de l'email est globale : vérifiée en contexte système, sans révéler à qui appartient l'email
  const taken = await tx({ system: true }, async (s) => (await s.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rowCount);
  if (taken) throw new AppError(409, 'Email déjà utilisé');

  const user = await tx(ctx(req), async (c) => {
    const u = (await c.query(
      `INSERT INTO users (tenant_id, email, full_name, role, permissions, password_hash, must_change_password, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING ${COLS}`,
      [req.user.tenantId, email, fullName, role, extra, await bcrypt.hash(pwd, 12), req.user.id])).rows[0];
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'user.created', entity: 'user', entityId: u.id, meta: { email, role, permissions: extra }, ip: req.ip });
    return u;
  });
  res.status(201).json({ user: present(user, req.user.enabledModules), temporaryPassword: b.password ? undefined : pwd });
}));

// PATCH /api/users/:id — nom, rôle, permissions, activation
router.patch('/:id', requirePermission('users:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const b = req.body || {};
  if (id === req.user.id) throw new AppError(400, 'Vous ne pouvez pas modifier votre propre compte ici');
  const sets = []; const vals = [id];
  const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (b.fullName !== undefined) add('full_name', v.str(b.fullName, { max: 120, field: 'nom complet' }));
  if (b.role !== undefined) add('role', v.oneOf(b.role, P.assignableRolesFor(req.user.role), 'rôle'));
  if (b.permissions !== undefined) {
    const extra = v.stringArray(b.permissions, 'permissions');
    const bad = P.invalidGrants(req.user.permissions, extra);
    if (bad.length) throw new AppError(403, `Permissions non accordables : ${bad.join(', ')}`);
    add('permissions', extra);
  }
  if (b.isActive !== undefined) { if (typeof b.isActive !== 'boolean') throw new AppError(400, 'isActive booléen requis'); add('is_active', b.isActive); }
  if (!sets.length) throw new AppError(400, 'Aucune modification');

  const user = await tx(ctx(req), async (c) => {
    const target = (await c.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
    if (!target) throw new AppError(404, 'Utilisateur introuvable');
    if (target.role === 'admin') throw new AppError(403, 'Le compte Admin ne peut être modifié que par le Superadmin');
    if (!P.canManageRole(req.user.role, target.role)) throw new AppError(403, 'Vous ne pouvez gérer que des comptes de rang inférieur au vôtre');
    const u = (await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, vals)).rows[0];
    if (b.isActive === false) await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'user.updated', entity: 'user', entityId: id, meta: b, ip: req.ip });
    return u;
  });
  res.json({ user: present(user, req.user.enabledModules) });
}));

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', requirePermission('users:write'), wrap(async (req, res) => {
  const id = v.uuid(req.params.id); const pwd = tempPassword();
  await tx(ctx(req), async (c) => {
    const target = (await c.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
    if (!target) throw new AppError(404, 'Utilisateur introuvable');
    if (target.role === 'admin' || id === req.user.id) throw new AppError(403, 'Action non autorisée sur ce compte');
    if (!P.canManageRole(req.user.role, target.role)) throw new AppError(403, 'Vous ne pouvez gérer que des comptes de rang inférieur au vôtre');
    await c.query('UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL WHERE id = $1', [id, await bcrypt.hash(pwd, 12)]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'user.password_reset', entity: 'user', entityId: id, ip: req.ip });
  });
  res.json({ temporaryPassword: pwd });
}));

// GET /api/users/audit/logs — journal d'audit de la pharmacie
router.get('/audit/logs', requirePermission('audit:read'), wrap(async (req, res) => {
  const rows = await tx(ctx(req), async (c) => (await c.query(`
    SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.ip, a.created_at, u.email AS user_email
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 100`)).rows);
  res.json({ logs: rows });
}));

module.exports = router;
