'use strict';

const config = require('./config');
const { pool } = require('./db');
const { getSecrets, SecretsMissingError } = require('./secrets');
const { createApp } = require('./app');
const { assertKeysCoverEvidence, StartupCheckError } = require('./services/startupChecks');

async function main() {
  // Refuse to start without the secrets file rather than inventing new keys.
  try {
    getSecrets();
  } catch (err) {
    if (err instanceof SecretsMissingError) {
      console.error(`\nEvidenceVault will not start: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`\nEvidenceVault will not start: cannot reach the database (${err.message}).`);
    console.error('Is PostgreSQL running? Try `docker compose up -d` from the project root.\n');
    process.exit(1);
  }

  try {
    await assertKeysCoverEvidence();
  } catch (err) {
    if (err instanceof StartupCheckError) {
      console.error(`\nEvidenceVault will not start: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  createApp().listen(config.port, () => {
    console.log(`EvidenceVault API listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
