'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');

const config = require('../config');
const { pool, withTransaction } = require('../db');
const { HttpError, asyncHandler } = require('../errors');
const { authenticate, signToken } = require('../middleware/auth');
const alerts = require('../services/alerts');
const audit = require('../services/audit');
const { publicUser } = require('../services/users');
const validate = require('../validate');

const router = express.Router();

// Compared against when the email is unknown, so response time does not reveal
// whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const INVALID = 'Invalid email or password';

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = validate.body(req);
    const email = validate.email(input.email);
    if (typeof input.password !== 'string' || input.password.length === 0) {
      throw new HttpError(400, 'password is required');
    }
    const ip = req.ip;

    const { rows } = await pool.query(
      `SELECT u.*, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked
         FROM users u WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];

    if (!user) {
      await bcrypt.compare(input.password, DUMMY_HASH);
      await audit.append({ action: 'LOGIN_FAILED', entity: 'user', details: { email, reason: 'unknown_email' }, ip });
      throw new HttpError(401, INVALID);
    }

    if (user.is_locked) {
      await audit.append({
        action: 'LOGIN_REFUSED_LOCKED',
        userId: user.id,
        entity: 'user',
        entityId: user.id,
        details: { lockedUntil: user.locked_until.toISOString() },
        ip,
      });
      throw new HttpError(423, 'Account is locked after too many failed sign-ins. Try again later.', {
        lockedUntil: user.locked_until.toISOString(),
      });
    }

    const passwordOk = await bcrypt.compare(input.password, user.password_hash);

    if (!user.active) {
      await audit.append({
        action: 'LOGIN_FAILED',
        userId: user.id,
        entity: 'user',
        entityId: user.id,
        details: { reason: 'inactive' },
        ip,
      });
      throw new HttpError(401, INVALID);
    }

    if (!passwordOk) {
      const { maxFailedLogins, minutes } = config.lockout;
      const lockedUntil = await withTransaction(async (tx) => {
        // One atomic update: count the failure and, on the last allowed
        // attempt, lock the account and reset the counter.
        const result = await tx.query(
          `UPDATE users
              SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                  locked_until  = CASE WHEN failed_logins + 1 >= $2
                                       THEN now() + make_interval(mins => $3) ELSE locked_until END,
                  updated_at    = now()
            WHERE id = $1
        RETURNING failed_logins, locked_until`,
          [user.id, maxFailedLogins, minutes],
        );
        const updated = result.rows[0];
        const justLocked = updated.failed_logins === 0;
        await audit.append(
          {
            action: justLocked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
            userId: user.id,
            entity: 'user',
            entityId: user.id,
            details: justLocked
              ? { reason: `${maxFailedLogins} failed sign-ins`, lockedUntil: updated.locked_until.toISOString() }
              : { reason: 'wrong_password', failedLogins: updated.failed_logins },
            ip,
          },
          tx,
        );
        if (justLocked) {
          await alerts.raise(
            {
              severity: 'warning',
              type: 'ACCOUNT_LOCKED',
              message: `Account ${user.email} locked for ${minutes} minutes after ${maxFailedLogins} failed sign-ins`,
              userId: user.id,
            },
            tx,
          );
          return updated.locked_until;
        }
        return null;
      });

      if (lockedUntil) {
        throw new HttpError(423, 'Account is locked after too many failed sign-ins. Try again later.', {
          lockedUntil: lockedUntil.toISOString(),
        });
      }
      throw new HttpError(401, INVALID);
    }

    const signedIn = await withTransaction(async (tx) => {
      const result = await tx.query(
        `UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [user.id],
      );
      await audit.append({ action: 'LOGIN_SUCCESS', userId: user.id, entity: 'user', entityId: user.id, ip }, tx);
      return result.rows[0];
    });

    res.json({ token: signToken(signedIn), user: publicUser(signedIn) });
  }),
);

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
