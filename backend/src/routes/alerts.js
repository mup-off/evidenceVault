'use strict';

const express = require('express');

const { pool, withTransaction } = require('../db');
const { HttpError, asyncHandler } = require('../errors');
const { requireRole } = require('../middleware/auth');
const audit = require('../services/audit');
const validate = require('../validate');

const router = express.Router();

function publicAlert(row) {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    severity: row.severity,
    type: row.type,
    message: row.message,
    userId: row.user_id,
    userName: row.user_name ?? null,
    evidenceId: row.evidence_id,
    evidenceCode: row.evidence_code ?? null,
    acknowledged: row.acknowledged,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedByName: row.acknowledged_by_name ?? null,
    acknowledgedAt: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
  };
}

const SELECT_ALERT = `
  SELECT a.*, u.full_name AS user_name, e.evidence_code, k.full_name AS acknowledged_by_name
    FROM alerts a
    LEFT JOIN users u    ON u.id = a.user_id
    LEFT JOIN evidence e ON e.id = a.evidence_id
    LEFT JOIN users k    ON k.id = a.acknowledged_by`;

// status: open (default) | acknowledged | all. severity: info | warning | critical.
router.get(
  '/',
  requireRole('administrator', 'auditor'),
  asyncHandler(async (req, res) => {
    const status = req.query.status ? validate.oneOf(req.query.status, 'status', ['open', 'acknowledged', 'all']) : 'open';
    const severity = req.query.severity
      ? validate.oneOf(req.query.severity, 'severity', ['info', 'warning', 'critical'])
      : null;
    const { rows } = await pool.query(
      `${SELECT_ALERT}
        WHERE ($1 = 'all' OR a.acknowledged = ($1 = 'acknowledged'))
          AND ($2::text IS NULL OR a.severity = $2)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 500`,
      [status, severity],
    );
    res.json({ alerts: rows.map(publicAlert) });
  }),
);

router.post(
  '/:id/acknowledge',
  requireRole('administrator'),
  asyncHandler(async (req, res) => {
    const alertId = validate.id(req.params.id);
    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT id, acknowledged, type FROM alerts WHERE id = $1 FOR UPDATE', [alertId]);
      if (!rows[0]) throw new HttpError(404, 'Alert not found');
      if (rows[0].acknowledged) throw new HttpError(409, 'This alert was already acknowledged');
      await tx.query(
        'UPDATE alerts SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = now() WHERE id = $2',
        [req.user.id, alertId],
      );
      await audit.append(
        { ...audit.fromRequest(req), action: 'ALERT_ACKNOWLEDGED', entity: 'alert', entityId: alertId, details: { type: rows[0].type } },
        tx,
      );
    });
    const { rows } = await pool.query(`${SELECT_ALERT} WHERE a.id = $1`, [alertId]);
    res.json({ alert: publicAlert(rows[0]) });
  }),
);

module.exports = router;
