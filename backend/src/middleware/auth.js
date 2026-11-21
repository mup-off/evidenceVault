'use strict';

const jwt = require('jsonwebtoken');

const config = require('../config');
const { pool } = require('../db');
const { HttpError, asyncHandler } = require('../errors');
const { getSecrets } = require('../secrets');
const { denyAccess } = require('../services/access');

function signToken(user) {
  return jwt.sign({ tv: user.token_version }, getSecrets().jwtSecret, {
    algorithm: 'HS256',
    subject: String(user.id),
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Verifies the bearer token, then re-reads the user from the database on every
 * request. A deactivated account, changed role or reset password takes effect
 * immediately instead of when the token expires.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'Sign-in required');

  let payload;
  try {
    payload = jwt.verify(match[1], getSecrets().jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new HttpError(401, 'Session is invalid or has expired; please sign in again');
  }

  const { rows } = await pool.query(
    'SELECT id, full_name, email, role, active, token_version FROM users WHERE id = $1',
    [Number(payload.sub)],
  );
  const user = rows[0];
  if (!user || !user.active || user.token_version !== payload.tv) {
    throw new HttpError(401, 'Session is no longer valid; please sign in again');
  }

  req.user = { id: user.id, fullName: user.full_name, email: user.email, role: user.role };
  next();
});

/** Allows only the listed roles; anything else is logged as ACCESS_DENIED. */
function requireRole(...roles) {
  return asyncHandler(async (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw await denyAccess(req, `role ${req.user.role} may not ${req.method} ${req.baseUrl}${req.route?.path ?? ''}`);
    }
    next();
  });
}

module.exports = { authenticate, requireRole, signToken };
