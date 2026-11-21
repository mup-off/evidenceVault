'use strict';

const { pool } = require('../db');
const { getSecrets } = require('../secrets');

class StartupCheckError extends Error {}

/**
 * Every key that stored evidence was encrypted with must be in secrets.json.
 * If one is missing (for example, the file was replaced by a fresh keygen),
 * starting would leave that evidence permanently unreadable, so refuse.
 */
async function assertKeysCoverEvidence() {
  const { keys } = getSecrets().encryption;
  const { rows } = await pool.query('SELECT key_id, count(*)::int AS items FROM evidence GROUP BY key_id');
  const missing = rows.filter((r) => !keys[r.key_id]);
  if (missing.length > 0) {
    const list = missing.map((r) => `${r.key_id} (${r.items} item${r.items === 1 ? '' : 's'})`).join(', ');
    throw new StartupCheckError(
      `Evidence is encrypted with key(s) missing from the secrets file: ${list}. ` +
        'Restore data/secrets.json from backup. Do not run keygen again.',
    );
  }
}

module.exports = { assertKeysCoverEvidence, StartupCheckError };
