'use strict';

// Runs once before the whole test suite: writes throwaway test keys, wipes the
// test database schema and applies every migration as the owner role.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const testEnv = require('./testEnv');

module.exports = async function globalSetup() {
  // Generated inline so this file does not load app config (which needs DATABASE_URL).
  const crypto = require('node:crypto');
  const key = () => crypto.randomBytes(32).toString('base64');
  fs.mkdirSync(path.dirname(testEnv.secretsPath), { recursive: true });
  fs.writeFileSync(
    testEnv.secretsPath,
    JSON.stringify({
      version: 1,
      jwtSecret: key(),
      auditHmacKey: key(),
      encryption: { currentKeyId: 'ktest', keys: { ktest: key() } },
    }),
  );

  const client = new Client({ connectionString: testEnv.ownerUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT USAGE ON SCHEMA public TO ev_app');
  } finally {
    await client.end();
  }

  execFileSync(
    process.execPath,
    [
      path.join(testEnv.backendRoot, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js'),
      'up',
      '-m',
      'db/migrations',
      '-d',
      'TEST_MIGRATION_DATABASE_URL',
      '--verbose=false',
    ],
    {
      cwd: testEnv.backendRoot,
      env: { ...process.env, TEST_MIGRATION_DATABASE_URL: testEnv.ownerUrl },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
};
