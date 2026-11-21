'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');

const config = require('../config');
const { pool, withTransaction } = require('../db');
const { HttpError, asyncHandler } = require('../errors');
const { requireRole } = require('../middleware/auth');
const audit = require('../services/audit');
const { publicUser } = require('../services/users');
const validate = require('../validate');

const router = express.Router();

// Minimal list of active users for pickers (case members now, transfer
// recipients in Phase 3). Available to every signed-in user.
router.get(
  '/directory',
  asyncHandler(async (req, res) => {
    const role = req.query.role ? validate.oneOf(req.query.role, 'role', validate.ROLES) : null;
    const { rows } = await pool.query(
      `SELECT id, full_name, role FROM users
        WHERE active AND ($1::text IS NULL OR role = $1)
        ORDER BY full_name`,
      [role],
    );
    res.json({ users: rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role })) });
  }),
);

// Everything below is user management: administrators only.
router.use(requireRole('administrator'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
    res.json({ users: rows.map(publicUser) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [validate.id(req.params.id)]);
    if (!rows[0]) throw new HttpError(404, 'User not found');
    res.json({ user: publicUser(rows[0]) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = validate.body(req);
    const fullName = validate.string(input.fullName, 'fullName');
    const email = validate.email(input.email);
    const role = validate.oneOf(input.role, 'role', validate.ROLES);
    const passwordHash = await bcrypt.hash(validate.password(input.password), config.bcryptRounds);

    const user = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO users (full_name, email, password_hash, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [fullName, email, passwordHash, role],
      );
      await audit.append(
        {
          ...audit.fromRequest(req),
          action: 'USER_CREATED',
          entity: 'user',
          entityId: rows[0].id,
          details: { email, role, fullName },
        },
        tx,
      );
      return rows[0];
    });
    res.status(201).json({ user: publicUser(user) });
  }),
);

// Body may contain any of: fullName, role, active, password, unlock (true).
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = validate.id(req.params.id);
    const input = validate.body(req);
    const isSelf = userId === req.user.id;

    const sets = [];
    const params = [];
    const changes = {};
    const set = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    let revokeSessions = false;

    if (input.fullName !== undefined) {
      changes.fullName = validate.string(input.fullName, 'fullName');
      set('full_name', changes.fullName);
    }
    if (input.role !== undefined) {
      changes.role = validate.oneOf(input.role, 'role', validate.ROLES);
      if (isSelf && changes.role !== 'administrator') {
        throw new HttpError(400, 'You cannot remove your own administrator role');
      }
      set('role', changes.role);
    }
    if (input.active !== undefined) {
      changes.active = validate.boolean(input.active, 'active');
      if (isSelf && !changes.active) throw new HttpError(400, 'You cannot deactivate your own account');
      set('active', changes.active);
      if (!changes.active) revokeSessions = true;
    }
    if (input.password !== undefined) {
      set('password_hash', await bcrypt.hash(validate.password(input.password), config.bcryptRounds));
      changes.passwordReset = true;
      revokeSessions = true;
    }
    if (input.unlock !== undefined) {
      if (input.unlock !== true) throw new HttpError(400, 'unlock must be true when given');
      sets.push('locked_until = NULL', 'failed_logins = 0');
      changes.unlocked = true;
    }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to update');
    if (revokeSessions) sets.push('token_version = token_version + 1');
    sets.push('updated_at = now()');

    const user = await withTransaction(async (tx) => {
      params.push(userId);
      const { rows } = await tx.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!rows[0]) throw new HttpError(404, 'User not found');
      await audit.append(
        { ...audit.fromRequest(req), action: 'USER_UPDATED', entity: 'user', entityId: userId, details: changes },
        tx,
      );
      return rows[0];
    });
    res.json({ user: publicUser(user) });
  }),
);

module.exports = router;
