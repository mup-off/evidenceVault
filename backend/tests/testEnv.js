'use strict';

// Shared by globalSetup and the per-file setup: reads .env and works out the
// test-only settings, so tests never touch the development database or keys.

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const backendRoot = path.join(__dirname, '..');
const envFile = path.join(backendRoot, '.env');
const fileEnv = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const get = (name) => process.env[name] || fileEnv[name];

const appUrl = get('TEST_DATABASE_URL');
const ownerUrl = get('TEST_MIGRATION_DATABASE_URL');
if (!appUrl || !ownerUrl) {
  throw new Error('Set TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL in backend/.env (see .env.example).');
}
const isTestDb = (url) => new URL(url).pathname.endsWith('_test');
if (!isTestDb(appUrl) || !isTestDb(ownerUrl)) {
  throw new Error('Test database names must end in _test; refusing to run tests against another database.');
}

module.exports = {
  backendRoot,
  appUrl,
  ownerUrl,
  secretsPath: path.join(backendRoot, 'tests', '.tmp', 'secrets.json'),
  evidenceDir: path.join(backendRoot, 'tests', '.tmp', 'evidence'),
};
