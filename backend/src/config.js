'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

const backendRoot = path.join(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: integer('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  secretsPath: path.resolve(backendRoot, process.env.SECRETS_PATH || 'data/secrets.json'),
  evidenceDir: path.resolve(backendRoot, process.env.EVIDENCE_DIR || 'data/evidence'),
  maxUploadBytes: integer('MAX_UPLOAD_MB', 100) * 1024 * 1024,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  bcryptRounds: integer('BCRYPT_ROUNDS', 12),
  lockout: {
    maxFailedLogins: integer('LOCKOUT_MAX_FAILED_LOGINS', 5),
    minutes: integer('LOCKOUT_MINUTES', 15),
  },
};

module.exports = config;
