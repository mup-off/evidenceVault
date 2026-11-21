'use strict';

const express = require('express');

const { pool, withTransaction } = require('../db');
const { asyncHandler } = require('../errors');
const { requireRole } = require('../middleware/auth');
const alerts = require('../services/alerts');
const audit = require('../services/audit');
const validate = require('../validate');

const router = express.Router();

// The audit log is for administrators and auditors only.
router.use(requireRole('administrator', 'auditor'));

// Newest first. Filters: action, entity, entityId, userId; page with beforeSeq.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query;
    const action = q.action ? validate.string(q.action, 'action', { max: 60 }).toUpperCase() : null;
    const entity = q.entity ? validate.string(q.entity, 'entity', { max: 60 }) : null;
    const entityId = q.entityId ? validate.string(q.entityId, 'entityId', { max: 60 }) : null;
    const userId = q.userId ? validate.id(q.userId, 'userId') : null;
    const beforeSeq = q.beforeSeq ? validate.id(q.beforeSeq, 'beforeSeq') : null;
    const limit = q.limit ? Math.min(validate.id(q.limit, 'limit'), 500) : 100;

    const { rows } = await pool.query(
      `SELECT a.*, u.full_name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1::text   IS NULL OR a.action = $1)
          AND ($2::text   IS NULL OR a.entity = $2)
          AND ($3::text   IS NULL OR a.entity_id = $3)
          AND ($4::bigint IS NULL OR a.user_id = $4)
          AND ($5::bigint IS NULL OR a.seq < $5)
        ORDER BY a.seq DESC
        LIMIT $6`,
      [action, entity, entityId, userId, beforeSeq, limit],
    );
    const entries = rows.map(audit.publicEntry);
    res.json({
      entries,
      head: await audit.head(),
      nextBeforeSeq: rows.length === limit ? rows[rows.length - 1].seq : null,
    });
  }),
);

router.get(
  '/head',
  asyncHandler(async (req, res) => {
    res.json({ head: await audit.head() });
  }),
);

// Checks the whole chain, logs the result and, if it is intact, anchors the
// new head. A broken chain raises a critical alert.
router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const result = await audit.verifyChain();
    const summary = result.intact ? `Chain intact: ${result.entriesChecked} entries checked` : audit.describeProblems(result);

    const anchor = await withTransaction(async (tx) => {
      await audit.append(
        {
          ...audit.fromRequest(req),
          action: result.intact ? 'AUDIT_CHAIN_VERIFIED' : 'AUDIT_CHAIN_BROKEN',
          entity: 'audit_log',
          details: {
            entriesChecked: result.entriesChecked,
            headSeq: result.head?.seq ?? null,
            brokenCount: result.brokenCount,
            firstBreakSeq: result.firstBreak?.seq ?? null,
            anchorProblems: result.anchors.problemCount,
          },
        },
        tx,
      );
      if (!result.intact) {
        await alerts.raise(
          { severity: 'critical', type: 'AUDIT_CHAIN_BROKEN', message: `Audit log chain check failed: ${summary}`, userId: req.user.id },
          tx,
        );
        return null;
      }
      return audit.anchor('chain_verified', tx);
    });

    res.json({ result: { ...result, summary }, anchor });
  }),
);

module.exports = router;
