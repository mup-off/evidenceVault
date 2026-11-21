'use strict';

const { pool } = require('../db');

/**
 * Raises a security alert for administrators and auditors.
 * alert: { severity: 'info'|'warning'|'critical', type, message, userId?, evidenceId? }
 */
async function raise(alert, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO alerts (severity, type, message, user_id, evidence_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [alert.severity, alert.type, alert.message, alert.userId ?? null, alert.evidenceId ?? null],
  );
  return rows[0].id;
}

module.exports = { raise };
