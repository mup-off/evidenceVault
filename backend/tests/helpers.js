'use strict';

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const request = require('supertest');

const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const testEnv = require('./testEnv');

const app = createApp();
// Owner connection: lets tests reset data and simulate someone with direct
// database access (for example, setting an expired lock).
const ownerPool = new Pool({ connectionString: testEnv.ownerUrl, max: 2 });

const PASSWORD = 'Correct-Horse-42';
let counter = 0;

// The append-only triggers reject TRUNCATE even for the owner, so the reset
// switches them off for the length of its own transaction.
async function resetData() {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER USER');
    await client.query('ALTER TABLE audit_anchors DISABLE TRIGGER USER');
    await client.query(
      `TRUNCATE alerts, audit_anchors, audit_log, custody_transfers, evidence, evidence_code_counters,
                case_members, cases, users
       RESTART IDENTITY CASCADE`,
    );
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER USER');
    await client.query('ALTER TABLE audit_anchors ENABLE TRIGGER USER');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  clearEvidenceDir();
}

function clearEvidenceDir() {
  const fs = require('node:fs');
  const path = require('node:path');
  if (!fs.existsSync(testEnv.evidenceDir)) return;
  for (const name of fs.readdirSync(testEnv.evidenceDir)) {
    const file = path.join(testEnv.evidenceDir, name);
    fs.chmodSync(file, 0o644);
    fs.rmSync(file, { force: true });
  }
}

async function createUser(role, overrides = {}) {
  counter += 1;
  const email = overrides.email || `${role}${counter}@test.local`;
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      overrides.fullName || `Test ${role} ${counter}`,
      email,
      await bcrypt.hash(overrides.password || PASSWORD, 4),
      role,
      overrides.active ?? true,
    ],
  );
  return { ...rows[0], password: overrides.password || PASSWORD };
}

async function login(user) {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** A signed-in user: { user, token, api } where api(method, url) is a supertest request with the token. */
async function signedIn(role, overrides) {
  const user = await createUser(role, overrides);
  const token = await login(user);
  const api = (method, url) => request(app)[method](url).set('Authorization', `Bearer ${token}`);
  return { user, token, api };
}

async function auditActions(action) {
  const { rows } = await pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY seq', [action]);
  return rows;
}

async function alertsOfType(type) {
  const { rows } = await pool.query('SELECT * FROM alerts WHERE type = $1 ORDER BY id', [type]);
  return rows;
}

/** Registers a random small file as evidence; returns the evidence object. */
async function registerEvidence(api, caseId, { title = 'Test item', file } = {}) {
  const crypto = require('node:crypto');
  const res = await api('post', '/api/evidence')
    .field('caseId', String(caseId))
    .field('title', title)
    .attach('file', file || crypto.randomBytes(2048), { filename: 'item.bin', contentType: 'application/octet-stream' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.evidence;
}

/** Path of an item's encrypted file on disk. */
async function storedPath(evidenceId) {
  const path = require('node:path');
  const { rows } = await ownerPool.query('SELECT storage_name FROM evidence WHERE id = $1', [evidenceId]);
  return path.join(testEnv.evidenceDir, rows[0].storage_name);
}

async function closeAll() {
  await Promise.all([pool.end(), ownerPool.end()]);
}

module.exports = {
  app,
  request,
  pool,
  ownerPool,
  PASSWORD,
  resetData,
  testEnv,
  createUser,
  login,
  signedIn,
  auditActions,
  alertsOfType,
  registerEvidence,
  storedPath,
  closeAll,
};
