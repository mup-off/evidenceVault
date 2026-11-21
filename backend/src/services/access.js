'use strict';

const { HttpError } = require('../errors');
const audit = require('./audit');
const alerts = require('./alerts');

/**
 * Records a refused action (ACCESS_DENIED in the audit log plus a warning
 * alert) and returns the 403 error to throw. Always written in its own
 * transaction so the record survives if the caller's work is rolled back.
 */
async function denyAccess(req, reason, { entity = null, entityId = null } = {}) {
  const who = req.user ? `${req.user.email} (${req.user.role})` : 'anonymous';
  await audit.append({
    ...audit.fromRequest(req),
    action: 'ACCESS_DENIED',
    entity,
    entityId,
    details: { reason, method: req.method, path: req.originalUrl },
  });
  await alerts.raise({
    severity: 'warning',
    type: 'ACCESS_DENIED',
    message: `Access denied for ${who}: ${reason}`,
    userId: req.user?.id ?? null,
  });
  return new HttpError(403, 'You do not have permission to do this');
}

module.exports = { denyAccess };
