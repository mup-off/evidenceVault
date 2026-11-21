'use strict';

const express = require('express');

const { pool, withTransaction } = require('../db');
const { HttpError, asyncHandler } = require('../errors');
const { requireRole } = require('../middleware/auth');
const { denyAccess } = require('../services/access');
const audit = require('../services/audit');
const cases = require('../services/cases');
const validate = require('../validate');

const router = express.Router();

function publicCase(row) {
  return {
    id: row.id,
    caseNumber: row.case_number,
    title: row.title,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}

async function listMembers(caseId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, m.added_at
       FROM case_members m JOIN users u ON u.id = m.user_id
      WHERE m.case_id = $1
      ORDER BY u.full_name`,
    [caseId],
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, role: r.role, addedAt: r.added_at.toISOString() }));
}

// List: everything for administrators, custodians and auditors; only assigned
// cases for investigators.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status ? validate.oneOf(req.query.status, 'status', ['open', 'closed']) : null;
    const onlyAssigned = req.user.role === 'investigator';
    const { rows } = await pool.query(
      `SELECT c.*, u.full_name AS created_by_name
         FROM cases c JOIN users u ON u.id = c.created_by
        WHERE ($1::text IS NULL OR c.status = $1)
          AND (NOT $2 OR EXISTS (SELECT 1 FROM case_members m WHERE m.case_id = c.id AND m.user_id = $3))
        ORDER BY c.created_at DESC`,
      [status, onlyAssigned, req.user.id],
    );
    res.json({ cases: rows.map(publicCase) });
  }),
);

router.post(
  '/',
  requireRole('administrator', 'investigator'),
  asyncHandler(async (req, res) => {
    const input = validate.body(req);
    const caseNumber = validate.string(input.caseNumber, 'caseNumber', { max: 50 });
    const title = validate.string(input.title, 'title');
    const description = validate.string(input.description, 'description', { optional: true, max: 5000 });

    const created = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO cases (case_number, title, description, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [caseNumber, title, description, req.user.id],
      );
      const row = rows[0];
      // An investigator who opens a case is automatically assigned to it.
      if (req.user.role === 'investigator') {
        await tx.query('INSERT INTO case_members (case_id, user_id, added_by) VALUES ($1, $2, $2)', [
          row.id,
          req.user.id,
        ]);
      }
      await audit.append(
        { ...audit.fromRequest(req), action: 'CASE_CREATED', entity: 'case', entityId: row.id, details: { caseNumber, title } },
        tx,
      );
      return row;
    });
    res.status(201).json({ case: publicCase(created) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const caseRow = await cases.getViewableCase(req, validate.id(req.params.id));
    res.json({ case: publicCase(caseRow), members: await listMembers(caseRow.id) });
  }),
);

// Body may contain any of: title, description, status ('open' | 'closed').
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const caseId = validate.id(req.params.id);
    const input = validate.body(req);
    const caseRow = await cases.getManageableCase(req, caseId);

    const sets = [];
    const params = [];
    const changes = {};
    const set = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) {
      changes.title = validate.string(input.title, 'title');
      set('title', changes.title);
    }
    if (input.description !== undefined) {
      changes.description = validate.string(input.description, 'description', { optional: true, max: 5000 });
      set('description', changes.description);
    }
    if (input.status !== undefined) {
      changes.status = validate.oneOf(input.status, 'status', ['open', 'closed']);
      if (changes.status !== caseRow.status) {
        // Only an administrator may reopen a closed case.
        if (changes.status === 'open' && req.user.role !== 'administrator') {
          throw await denyAccess(req, `only an administrator may reopen case ${caseRow.case_number}`, {
            entity: 'case',
            entityId: caseRow.id,
          });
        }
        set('status', changes.status);
        sets.push(changes.status === 'closed' ? 'closed_at = now()' : 'closed_at = NULL');
      }
    }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to update');
    sets.push('updated_at = now()');

    const updated = await withTransaction(async (tx) => {
      params.push(caseId);
      const { rows } = await tx.query(`UPDATE cases SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      const action =
        changes.status && changes.status !== caseRow.status
          ? changes.status === 'closed'
            ? 'CASE_CLOSED'
            : 'CASE_REOPENED'
          : 'CASE_UPDATED';
      await audit.append({ ...audit.fromRequest(req), action, entity: 'case', entityId: caseId, details: changes }, tx);
      return rows[0];
    });
    res.json({ case: publicCase(updated) });
  }),
);

router.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const caseId = validate.id(req.params.id);
    const userId = validate.id(validate.body(req).userId, 'userId');
    const caseRow = await cases.getManageableCase(req, caseId);

    const { rows } = await pool.query('SELECT id, role, active FROM users WHERE id = $1', [userId]);
    const member = rows[0];
    if (!member) throw new HttpError(404, 'User not found');
    if (member.role !== 'investigator' || !member.active) {
      throw new HttpError(400, 'Only active investigators can be assigned to a case');
    }

    await withTransaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO case_members (case_id, user_id, added_by) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [caseId, userId, req.user.id],
      );
      if (result.rowCount === 0) throw new HttpError(409, 'That investigator is already assigned to this case');
      await audit.append(
        {
          ...audit.fromRequest(req),
          action: 'CASE_MEMBER_ADDED',
          entity: 'case',
          entityId: caseId,
          details: { caseNumber: caseRow.case_number, memberId: userId },
        },
        tx,
      );
    });
    res.status(201).json({ members: await listMembers(caseId) });
  }),
);

router.delete(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const caseId = validate.id(req.params.id);
    const userId = validate.id(req.params.userId, 'userId');
    const caseRow = await cases.getManageableCase(req, caseId);
    if (userId === caseRow.created_by) {
      throw new HttpError(400, 'The investigator who opened the case cannot be removed from it');
    }

    await withTransaction(async (tx) => {
      const result = await tx.query('DELETE FROM case_members WHERE case_id = $1 AND user_id = $2', [caseId, userId]);
      if (result.rowCount === 0) throw new HttpError(404, 'That user is not assigned to this case');
      await audit.append(
        {
          ...audit.fromRequest(req),
          action: 'CASE_MEMBER_REMOVED',
          entity: 'case',
          entityId: caseId,
          details: { caseNumber: caseRow.case_number, memberId: userId },
        },
        tx,
      );
    });
    res.json({ members: await listMembers(caseId) });
  }),
);

module.exports = router;
