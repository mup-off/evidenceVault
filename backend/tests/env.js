'use strict';

// Runs in every test file before any app code is loaded.
const testEnv = require('./testEnv');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testEnv.appUrl;
process.env.SECRETS_PATH = testEnv.secretsPath;
process.env.EVIDENCE_DIR = testEnv.evidenceDir;
process.env.MAX_UPLOAD_MB = '1'; // small limit so the size check is cheap to test
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests only
process.env.LOCKOUT_MAX_FAILED_LOGINS = '5';
process.env.LOCKOUT_MINUTES = '15';
