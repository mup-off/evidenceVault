'use strict';

const express = require('express');

const { pool } = require('../db');
const { asyncHandler } = require('../errors');
const custody = require('../services/custody');

const router = express.Router();

// Role-aware counts for the dashboard. Investigators see only their assigned
// cases; open alerts are included for administrators and auditors.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user;
    const onlyAssigned = user.role === 'investigator';
    const visibleCase = `(NOT $1 OR EXISTS (SELECT 1 FROM case_members m WHERE m.case_id = c.id AND m.user_id = $2))`;

    const [caseCounts, evidenceCounts, holding, outgoing, incoming] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE c.status = 'open')::int   AS open,
                count(*) FILTER (WHERE c.status = 'closed')::int AS closed
           FROM cases c WHERE ${visibleCase}`,
        [onlyAssigned, user.id],
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE e.integrity_status = 'verified')::int   AS verified,
                count(*) FILTER (WHERE e.integrity_status = 'unverified')::int AS unverified,
                count(*) FILTER (WHERE e.integrity_status = 'failed')::int     AS failed
           FROM evidence e JOIN cases c ON c.id = e.case_id WHERE ${visibleCase}`,
        [onlyAssigned, user.id],
      ),
      pool.query('SELECT count(*)::int AS n FROM evidence WHERE current_custodian_id = $1', [user.id]),
      pool.query(
        `SELECT count(*)::int AS n FROM custody_transfers
          WHERE status = 'pending' AND (from_user_id = $1 OR requested_by = $1)`,
        [user.id],
      ),
      custody.list(user, { status: 'pending', direction: 'incoming', limit: 20 }),
    ]);

    const body = {
      cases: caseCounts.rows[0],
      evidence: evidenceCounts.rows[0],
      custody: {
        holding: holding.rows[0].n,
        incomingPending: incoming.length,
        outgoingPending: outgoing.rows[0].n,
        waitingForYou: incoming,
      },
    };

    if (user.role === 'administrator' || user.role === 'auditor') {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS open,
                count(*) FILTER (WHERE severity = 'critical')::int AS critical
           FROM alerts WHERE NOT acknowledged`,
      );
      const latest = await pool.query(
        `SELECT id, created_at, severity, type, message FROM alerts
          WHERE NOT acknowledged ORDER BY created_at DESC, id DESC LIMIT 5`,
      );
      body.alerts = {
        ...rows[0],
        latest: latest.rows.map((a) => ({
          id: a.id,
          createdAt: a.created_at.toISOString(),
          severity: a.severity,
          type: a.type,
          message: a.message,
        })),
      };
    }

    res.json(body);
  }),
);

module.exports = router;
