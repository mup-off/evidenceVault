'use strict';

// The server must refuse to start rather than run with missing keys.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const h = require('./helpers');
const { assertKeysCoverEvidence } = require('../src/services/startupChecks');

beforeEach(h.resetData);
afterAll(h.closeAll);

function startServer(env) {
  return spawnSync(process.execPath, [path.join(h.testEnv.backendRoot, 'src', 'server.js')], {
    env: { ...process.env, PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
}

async function registerOneItem() {
  const inv = await h.signedIn('investigator');
  const { body } = await inv.api('post', '/api/cases').send({ caseNumber: 'K-1', title: 'Key test' });
  const res = await inv
    .api('post', '/api/evidence')
    .field('caseId', String(body.case.id))
    .field('title', 'item')
    .attach('file', Buffer.from('content'), { filename: 'a.txt' });
  return res.body.evidence;
}

test('without secrets.json the server refuses to start and explains why', () => {
  const run = startServer({ SECRETS_PATH: path.join(h.testEnv.backendRoot, 'tests', '.tmp', 'no-such-file.json') });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/will not start: Secrets file not found/);
  expect(run.stderr).toMatch(/restore the file from backup/);
});

test('the key check passes when every evidence key is present', async () => {
  await registerOneItem();
  await expect(assertKeysCoverEvidence()).resolves.toBeUndefined();
});

test('evidence encrypted with a key missing from secrets.json stops the server', async () => {
  const ev = await registerOneItem();
  // Simulate secrets.json having been replaced: the item's key is no longer known.
  await h.ownerPool.query("UPDATE evidence SET key_id = 'k-lost' WHERE id = $1", [ev.id]);

  await expect(assertKeysCoverEvidence()).rejects.toThrow(/k-lost \(1 item\)/);

  const run = startServer({});
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/will not start: Evidence is encrypted with key\(s\) missing/);
});
