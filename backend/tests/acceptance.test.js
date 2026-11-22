'use strict';

// One test per row of the "Testing and demo plan" table in plan.md (R01-R20).
// Test names start with the row number so the test report can map them 1:1.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const h = require('./helpers');
const tamper = require('../scripts/tamper/lib');

beforeEach(h.resetData);
afterAll(h.closeAll);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function caseWithItem({ file } = {}) {
  const inv = await h.signedIn('investigator');
  const { body } = await inv.api('post', '/api/cases').send({ caseNumber: 'RIB-ACC-1', title: 'Acceptance' });
  const evidence = await h.registerEvidence(inv.api, body.case.id, { file });
  return { inv, caseId: body.case.id, evidence };
}

async function withOwner(fn) {
  const client = await h.ownerPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

describe('Testing and demo plan', () => {
  test('R01 Sign-in: five wrong passwords lock the account for 15 minutes and raise an alert', async () => {
    const user = await h.createUser('investigator');
    for (let i = 0; i < 5; i += 1) {
      await h.request(h.app).post('/api/auth/login').send({ email: user.email, password: 'wrong-password' });
    }
    const res = await h.request(h.app).post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(423);
    const minutes = (new Date(res.body.lockedUntil) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(await h.alertsOfType('ACCOUNT_LOCKED')).toHaveLength(1);
  });

  test('R02 Sign-in: a deactivated user is refused at once; the old token stops working', async () => {
    const admin = await h.signedIn('administrator');
    const target = await h.signedIn('investigator');
    expect((await target.api('get', '/api/auth/me')).status).toBe(200);
    await admin.api('patch', `/api/users/${target.user.id}`).send({ active: false });
    expect((await target.api('get', '/api/auth/me')).status).toBe(401);
  });

  test('R03 Access: an unassigned investigator is refused, ACCESS_DENIED is logged and an alert raised', async () => {
    const { caseId } = await caseWithItem();
    const outsider = await h.signedIn('investigator');
    expect((await outsider.api('get', `/api/cases/${caseId}`)).status).toBe(403);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(1);
    expect(await h.alertsOfType('ACCESS_DENIED')).toHaveLength(1);
  });

  test('R04 Access: an auditor trying to download a file is refused with 403', async () => {
    const { evidence } = await caseWithItem();
    const auditor = await h.signedIn('auditor');
    expect((await auditor.api('get', `/api/evidence/${evidence.id}/download`)).status).toBe(403);
  });

  test('R05 Intake: the SHA-256 is recorded and the stored file is encrypted and unreadable on disk', async () => {
    const original = Buffer.from(`Screenshot text: threat received at Nyabugogo ${'x'.repeat(500)}`);
    const { evidence } = await caseWithItem({ file: original });
    expect(evidence.sha256).toBe(sha(original));
    const onDisk = fs.readFileSync(await h.storedPath(evidence.id));
    expect(onDisk.includes(Buffer.from('Nyabugogo'))).toBe(false);
    expect(sha(onDisk)).toBe(evidence.storedFileSha256);
  });

  test('R06 Intake: uploading the same file twice warns of the duplicate', async () => {
    const file = crypto.randomBytes(300);
    const { inv, caseId } = await caseWithItem({ file });
    const res = await inv
      .api('post', '/api/evidence')
      .field('caseId', String(caseId))
      .field('title', 'Again')
      .attach('file', file, { filename: 'again.bin' });
    expect(res.status).toBe(201);
    expect(res.body.warnings[0].type).toBe('DUPLICATE_FILE');
  });

  test('R07 Intake: registering evidence on a closed case is refused', async () => {
    const { inv, caseId } = await caseWithItem();
    await inv.api('patch', `/api/cases/${caseId}`).send({ status: 'closed' });
    const res = await inv
      .api('post', '/api/evidence')
      .field('caseId', String(caseId))
      .field('title', 'Late')
      .attach('file', crypto.randomBytes(100), { filename: 'late.bin' });
    expect(res.status).toBe(409);
  });

  test('R08 Integrity: an untouched file verifies; hashes match', async () => {
    const { inv, evidence } = await caseWithItem();
    const res = await inv.api('post', `/api/evidence/${evidence.id}/verify`);
    expect(res.body.result.status).toBe('verified');
    expect(res.body.result.current).toEqual({ sha256: evidence.sha256, storedFileSha256: evidence.storedFileSha256 });
  });

  test('R09 Integrity: one flipped byte fails, shows both stored-file hashes, decryption authentication fails, critical alert', async () => {
    const { inv, evidence } = await caseWithItem();
    tamper.flipStoredByte(await h.storedPath(evidence.id));
    const { result } = (await inv.api('post', `/api/evidence/${evidence.id}/verify`)).body;
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual(expect.arrayContaining(['STORED_FILE_CHANGED', 'DECRYPTION_AUTH_FAILED']));
    expect(result.recorded.storedFileSha256).toBe(evidence.storedFileSha256);
    expect(result.current.storedFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.current.storedFileSha256).not.toBe(evidence.storedFileSha256);
    const [alert] = await h.alertsOfType('INTEGRITY_FAILED');
    expect(alert.severity).toBe('critical');
  });

  test('R10 Integrity: a deleted stored file fails as missing, with a critical alert', async () => {
    const { inv, evidence } = await caseWithItem();
    tamper.deleteStoredFile(await h.storedPath(evidence.id));
    const { result } = (await inv.api('post', `/api/evidence/${evidence.id}/verify`)).body;
    expect(result).toMatchObject({ status: 'failed', reasons: ['FILE_MISSING'] });
    expect((await h.alertsOfType('INTEGRITY_FAILED'))[0].severity).toBe('critical');
  });

  test('R11 Integrity: downloading a tampered file is blocked', async () => {
    const { inv, evidence } = await caseWithItem();
    tamper.flipStoredByte(await h.storedPath(evidence.id));
    const res = await inv.api('get', `/api/evidence/${evidence.id}/download`);
    expect(res.status).toBe(409);
    expect(await h.auditActions('DOWNLOAD_BLOCKED')).toHaveLength(1);
    expect(await h.auditActions('EVIDENCE_DOWNLOADED')).toHaveLength(0);
  });

  test('R12 Custody: a transfer the custodian accepts changes the custodian; both steps are in the history', async () => {
    const { inv, evidence } = await caseWithItem();
    const cus = await h.signedIn('custodian');
    const t = await inv.api('post', `/api/evidence/${evidence.id}/transfers`).send({ toUserId: cus.user.id, reason: 'Storage' });
    await cus.api('post', `/api/transfers/${t.body.transfer.id}/accept`);
    const item = await cus.api('get', `/api/evidence/${evidence.id}`);
    expect(item.body.evidence.currentCustodianId).toBe(cus.user.id);
    const history = (await cus.api('get', `/api/evidence/${evidence.id}/history`)).body.history.map((e) => e.action);
    expect(history).toEqual(expect.arrayContaining(['CUSTODY_TRANSFER_REQUESTED', 'CUSTODY_TRANSFER_ACCEPTED']));
  });

  test('R13 Custody: a non-custodian requesting a transfer is refused', async () => {
    const { evidence } = await caseWithItem();
    const cus = await h.signedIn('custodian');
    const other = await h.signedIn('custodian');
    const res = await cus.api('post', `/api/evidence/${evidence.id}/transfers`).send({ toUserId: other.user.id, reason: 'Not mine' });
    expect(res.status).toBe(403);
  });

  test('R14 Custody: two simultaneous accepts of the same item: only one succeeds', async () => {
    const { inv, evidence } = await caseWithItem();
    const cus = await h.signedIn('custodian');
    const t = await inv.api('post', `/api/evidence/${evidence.id}/transfers`).send({ toUserId: cus.user.id, reason: 'Race' });
    const url = `/api/transfers/${t.body.transfer.id}/accept`;
    const results = await Promise.all([cus.api('post', url), cus.api('post', url)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await h.auditActions('CUSTODY_TRANSFER_ACCEPTED')).toHaveLength(1);
  });

  test('R15 Audit: editing one entry in the database breaks the chain at that entry', async () => {
    await caseWithItem();
    const auditor = await h.signedIn('auditor');
    await withOwner((c) => tamper.backdateEntry(c, 2));
    const { result } = (await auditor.api('post', '/api/audit/verify')).body;
    expect(result.intact).toBe(false);
    expect(result.firstBreak.seq).toBe(2);
    expect(result.brokenCount).toBe(1);
  });

  test('R16 Audit: editing an entry and recomputing later hashes with plain SHA-256 is still detected', async () => {
    await caseWithItem();
    const auditor = await h.signedIn('auditor');
    await withOwner((c) => tamper.backdateAndRecompute(c, 2));
    const { result } = (await auditor.api('post', '/api/audit/verify')).body;
    expect(result.intact).toBe(false);
    expect(result.firstBreak).toMatchObject({ seq: 2, problem: 'ENTRY_HASH_MISMATCH' });
  });

  test('R17 Audit: deleting the newest entries is detected because the anchored head is gone', async () => {
    const { evidence } = await caseWithItem();
    const auditor = await h.signedIn('auditor');
    await auditor.api('get', `/api/evidence/${evidence.id}/report`); // anchors the head
    await withOwner((c) => tamper.deleteNewest(c, 2));
    const { result } = (await auditor.api('post', '/api/audit/verify')).body;
    expect(result.intact).toBe(false);
    expect(result.anchors.problems[0].problem).toBe('ANCHORED_ENTRY_MISSING');
  });

  test.each([
    ['TRUNCATE', 'TRUNCATE audit_log'],
    ['UPDATE', "UPDATE audit_log SET action = 'X'"],
    ['DELETE', 'DELETE FROM audit_log'],
  ])('R18 Audit: %s on audit_log as the app role is refused by the database', async (_op, sql) => {
    await caseWithItem();
    await expect(h.pool.query(sql)).rejects.toThrow(/permission denied/);
  });

  test('R19 Keys: without secrets.json the server refuses to start with a clear message', () => {
    const run = spawnSync(process.execPath, [path.join(h.testEnv.backendRoot, 'src', 'server.js')], {
      env: { ...process.env, PORT: '0', SECRETS_PATH: path.join(h.testEnv.backendRoot, 'tests', '.tmp', 'missing.json') },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/will not start: Secrets file not found/);
  });

  test('R20 Report: fresh integrity check, full history and the chain head', async () => {
    const { evidence } = await caseWithItem();
    const auditor = await h.signedIn('auditor');
    const requestedAt = Date.now();
    const { report } = (await auditor.api('get', `/api/evidence/${evidence.id}/report`)).body;
    expect(report.integrity.status).toBe('verified');
    // The check ran during this request, not earlier.
    expect(new Date(report.integrity.checkedAt).getTime()).toBeGreaterThanOrEqual(requestedAt - 5);
    expect(report.history.map((e) => e.action)).toEqual(['EVIDENCE_REGISTERED', 'INTEGRITY_VERIFIED', 'REPORT_GENERATED']);
    const head = (await h.pool.query('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
    expect(report.chainHead).toMatchObject({ seq: head.seq, entryHash: head.entry_hash });
  });
});
