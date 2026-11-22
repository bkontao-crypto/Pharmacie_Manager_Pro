'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { encrypt, decrypt, sha256, randomToken } = require('../lib/crypto');
const totp = require('../lib/totp');
const { signAccess, signTemp, verifyToken, authenticate, blockIfMustChange } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const cookies = require('../lib/cookies');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.LOGIN_RATE_MAX) || 20, /* LOGIN_RATE_MAX : uniquement pour les tests automatisés */ message: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' });
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12); // égalise le temps de réponse si l'email n'existe pas

const cookieOpts = () => ({ secure: config.isProd });
/** Pose le refresh token en cookie HttpOnly ; le corps de la réponse ne contient QUE le jeton d'accès (jamais le refresh). */
function sendSession(res, tokens, extra = {}) {
  cookies.setRefreshCookie(res, tokens.refreshToken, cookieOpts());
  res.json({ accessToken: tokens.accessToken, ...extra });
}

const publicUser = (u) => ({
  id: u.id, email: u.email, fullName: u.fullName ?? u.full_name, role: u.role,
  tenantId: u.tenantId ?? u.tenant_id, tenantName: u.tenantName, timezone: u.timezone,
  mustChangePassword: u.mustChangePassword ?? u.must_change_password,
  totpEnabled: u.totpEnabled ?? u.totp_enabled,
  permissions: u.permissions, enabledModules: u.enabledModules,
  // multi-sites (v0.7.0) : pharmacie de travail, groupe, restrictions
  acting: u.acting, homeTenantId: u.homeTenantId, homeTenantName: u.homeTenantName, isGroupAdmin: u.isGroupAdmin, isSubsite: u.isSubsite, inGroup: u.inGroup,
  groupMaxSites: u.groupMaxSites, patientDataRestricted: u.patientDataRestricted,
});

/** Émet access token + refresh token (stocké haché, rotation à chaque usage). */
async function issueTokens(client, user, req) {
  const refresh = randomToken();
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2, now() + ($3 || ' days')::interval, $4, $5)`,
    [user.id, sha256(refresh), String(config.refreshTtlDays), req.ip, (req.get('user-agent') || '').slice(0, 200)],
  );
  return { accessToken: signAccess(user), refreshToken: refresh };
}

async function completeLogin(client, user, req) {
  await client.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  await audit(client, { tenantId: user.tenant_id, userId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, ip: req.ip });
  return issueTokens(client, user, req);
}

// POST /api/auth/login
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = v.email(req.body?.email);
  const pwd = v.str(req.body?.password, { max: 128, field: 'mot de passe' });

  const out = await tx({ system: true }, async (c) => {
    const user = (await c.query('SELECT * FROM users WHERE lower(email) = $1', [email])).rows[0];
    const ok = await bcrypt.compare(pwd, user ? user.password_hash : DUMMY_HASH);

    if (!user || !user.is_active) { await bcrypt.compare(pwd, DUMMY_HASH); return { fail: true }; }
    if (user.locked_until && new Date(user.locked_until) > new Date()) return { locked: true };

    if (!ok) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= config.maxFailedLogins ? `now() + interval '${config.lockMinutes} minutes'` : 'NULL';
      await c.query(`UPDATE users SET failed_attempts = $2, locked_until = ${lock} WHERE id = $1`, [user.id, attempts]);
      await audit(c, { tenantId: user.tenant_id, userId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id, ip: req.ip, meta: { attempts } });
      return { fail: true };
    }
    if (user.totp_enabled) return { requires2fa: true, tempToken: signTemp(user) };
    return { tokens: await completeLogin(c, user, req), user };
  });

  if (out.locked) throw new AppError(423, `Compte temporairement verrouillé (${config.lockMinutes} min) après trop d'échecs.`, 'LOCKED');
  if (out.fail) throw new AppError(401, 'Email ou mot de passe incorrect');
  if (out.requires2fa) return res.json({ requires2fa: true, tempToken: out.tempToken });
  sendSession(res, out.tokens, { user: { id: out.user.id, role: out.user.role, mustChangePassword: out.user.must_change_password } });
}));

// POST /api/auth/2fa/login — second facteur
router.post('/2fa/login', loginLimiter, wrap(async (req, res) => {
  const payload = verifyToken(req.body?.tempToken, '2fa');
  const code = v.str(req.body?.code, { max: 10, field: 'code' });
  const out = await tx({ system: true }, async (c) => {
    const user = (await c.query('SELECT * FROM users WHERE id = $1 AND is_active', [payload.sub])).rows[0];
    if (!user || !user.totp_enabled) return { fail: true };
    if (user.locked_until && new Date(user.locked_until) > new Date()) return { locked: true };
    if (!totp.verify(decrypt(user.totp_secret_enc), code)) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= config.maxFailedLogins ? `now() + interval '${config.lockMinutes} minutes'` : 'NULL';
      await c.query(`UPDATE users SET failed_attempts = $2, locked_until = ${lock} WHERE id = $1`, [user.id, attempts]);
      await audit(c, { tenantId: user.tenant_id, userId: user.id, action: 'auth.2fa_failed', entity: 'user', entityId: user.id, ip: req.ip });
      return { fail: true };
    }
    return { tokens: await completeLogin(c, user, req), user };
  });
  if (out.locked) throw new AppError(423, 'Compte temporairement verrouillé.', 'LOCKED');
  if (out.fail) throw new AppError(401, 'Code de vérification incorrect');
  sendSession(res, out.tokens, { user: { id: out.user.id, role: out.user.role, mustChangePassword: out.user.must_change_password } });
}));

// POST /api/auth/refresh — rotation du refresh token (détection de réutilisation → révocation de toutes les sessions)
router.post('/refresh', wrap(async (req, res) => {
  const token = cookies.readCookie(req.headers.cookie);
  if (!token || token.length > 200) { cookies.clearRefreshCookie(res, cookieOpts()); throw new AppError(401, 'Session expirée, veuillez vous reconnecter', 'TOKEN_INVALID'); }
  const out = await tx({ system: true }, async (c) => {
    const row = (await c.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [sha256(token)])).rows[0];
    if (!row) return { fail: true };
    if (row.revoked_at) {
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
      return { fail: true };
    }
    if (new Date(row.expires_at) < new Date()) return { fail: true };
    const user = (await c.query('SELECT * FROM users WHERE id = $1 AND is_active', [row.user_id])).rows[0];
    if (!user) return { fail: true };
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    return { tokens: await issueTokens(c, user, req) };
  });
  if (out.fail) { cookies.clearRefreshCookie(res, cookieOpts()); throw new AppError(401, 'Session expirée, veuillez vous reconnecter', 'TOKEN_INVALID'); }
  sendSession(res, out.tokens);
}));

// POST /api/auth/logout
router.post('/logout', wrap(async (req, res) => {
  const token = cookies.readCookie(req.headers.cookie);
  if (token) {
    await tx({ system: true }, (c) => c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]));
  }
  cookies.clearRefreshCookie(res, cookieOpts());
  res.json({ ok: true });
}));

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

// POST /api/auth/change-password
router.post('/change-password', authenticate, wrap(async (req, res) => {
  const current = v.str(req.body?.currentPassword, { max: 128, field: 'mot de passe actuel' });
  const next = v.password(req.body?.newPassword, 'nouveau mot de passe');
  if (next === current) throw new AppError(400, 'Le nouveau mot de passe doit être différent');
  await tx({ system: true }, async (c) => {
    const u = (await c.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!(await bcrypt.compare(current, u.password_hash))) throw new AppError(400, 'Mot de passe actuel incorrect');
    await c.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [req.user.id, await bcrypt.hash(next, 12)]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]); // déconnecte les autres sessions
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'auth.password_changed', entity: 'user', entityId: req.user.id, ip: req.ip });
  });
  cookies.clearRefreshCookie(res, cookieOpts());
  res.json({ ok: true });
}));

// --- 2FA (TOTP) ---
router.post('/2fa/setup', authenticate, blockIfMustChange, wrap(async (req, res) => {
  if (req.user.totpEnabled) throw new AppError(400, '2FA déjà activée');
  const secret = totp.generateSecret();
  await tx({ system: true }, (c) => c.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [req.user.id, encrypt(secret)]));
  res.json({ secret, otpauthUri: totp.otpauthUri(secret, req.user.email) });
}));

router.post('/2fa/enable', authenticate, blockIfMustChange, wrap(async (req, res) => {
  const code = v.str(req.body?.code, { max: 10, field: 'code' });
  await tx({ system: true }, async (c) => {
    const u = (await c.query('SELECT totp_secret_enc FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!u?.totp_secret_enc) throw new AppError(400, 'Lancez d\'abord la configuration 2FA');
    if (!totp.verify(decrypt(u.totp_secret_enc), code)) throw new AppError(400, 'Code incorrect');
    await c.query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user.id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'auth.2fa_enabled', entity: 'user', entityId: req.user.id, ip: req.ip });
  });
  res.json({ ok: true });
}));

router.post('/2fa/disable', authenticate, blockIfMustChange, wrap(async (req, res) => {
  const pwd = v.str(req.body?.password, { max: 128, field: 'mot de passe' });
  const code = v.str(req.body?.code, { max: 10, field: 'code' });
  await tx({ system: true }, async (c) => {
    const u = (await c.query('SELECT password_hash, totp_secret_enc, totp_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!u.totp_enabled) throw new AppError(400, '2FA non activée');
    if (!(await bcrypt.compare(pwd, u.password_hash)) || !totp.verify(decrypt(u.totp_secret_enc), code)) throw new AppError(400, 'Mot de passe ou code incorrect');
    await c.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL WHERE id = $1', [req.user.id]);
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: 'auth.2fa_disabled', entity: 'user', entityId: req.user.id, ip: req.ip });
  });
  res.json({ ok: true });
}));

module.exports = router;
