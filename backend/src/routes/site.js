'use strict';
/**
 * Accès de l'Admin du groupe aux dossiers patients d'UNE sous-pharmacie : décidé uniquement par le gérant local de cette
 * sous-pharmacie (ni le Superadmin, ni l'Admin du groupe lui-même). Fermé par défaut ; retrait immédiat ; chaque octroi/retrait est audité.
 */
const express = require('express');
const { tx, audit } = require('../db');
const { AppError, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { authenticate, blockIfMustChange, requireTenantUser, requireLocalManager } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, blockIfMustChange, requireTenantUser, requireLocalManager);

router.get('/patient-access', wrap(async (req, res) => {
  const t = await tx({ system: true }, async (c) => (await c.query(
    `SELECT t.group_patient_access AS granted, p.name AS group_name FROM tenants t JOIN tenants p ON p.id = t.parent_id WHERE t.id = $1`, [req.user.tenantId])).rows[0]);
  if (!t) throw new AppError(409, 'Cette pharmacie n’est pas une sous-pharmacie');
  res.json({ granted: t.granted, groupName: t.group_name });
}));

router.put('/patient-access', wrap(async (req, res) => {
  const granted = v.bool(req.body?.granted, 'accès');
  await tx({ system: true }, async (c) => {
    const r = await c.query('UPDATE tenants SET group_patient_access = $2 WHERE id = $1 AND parent_id IS NOT NULL RETURNING id', [req.user.tenantId, granted]);
    if (!r.rowCount) throw new AppError(409, 'Cette pharmacie n’est pas une sous-pharmacie');
    await audit(c, { tenantId: req.user.tenantId, userId: req.user.id, action: granted ? 'site.patient_access_granted' : 'site.patient_access_revoked', entity: 'tenant', entityId: req.user.tenantId, ip: req.ip });
  });
  res.json({ granted });
}));

module.exports = router;
