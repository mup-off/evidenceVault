'use strict';

const h = require('./helpers');
const tamper = require('../scripts/tamper/lib');

beforeEach(h.resetData);
afterAll(h.closeAll);

async function setup() {
  const inv = await h.signedIn('investigator');
  const custodian = await h.signedIn('custodian');
  const auditor = await h.signedIn('auditor');
  const { body } = await inv.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-500', title: 'Online scam' });
  const evidence = await h.registerEvidence(inv.api, body.case.id, { title: 'Bank SMS screenshot' });
  const t = await inv.api('post', `/api/evidence/${evidence.id}/transfers`).send({ toUserId: custodian.user.id, reason: 'Storage' });
  await custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`);
  return { inv, custodian, auditor, caseId: body.case.id, evidence };
}

describe('chain-of-custody report', () => {
  test('runs a fresh integrity check, includes the full history and prints the anchored chain head', async () => {
    const { auditor, custodian, inv, evidence } = await setup();
    const res = await auditor.api('get', `/api/evidence/${evidence.id}/report`);

    expect(res.status).toBe(200);
    const r = res.body.report;
    expect(r.evidence).toMatchObject({ evidenceCode: evidence.evidenceCode, sha256: evidence.sha256, integrityStatus: 'verified' });
    expect(r.case).toMatchObject({ caseNumber: 'RIB-2026-500', status: 'open' });
    expect(r.integrity).toMatchObject({ status: 'verified', reasons: [] });
    expect(r.generatedBy).toMatchObject({ id: auditor.user.id, role: 'auditor' });
    expect(r.custody.current).toMatchObject({ id: custodian.user.id, role: 'custodian' });
    expect(r.custody.transfers).toEqual([
      expect.objectContaining({ status: 'accepted', from: expect.objectContaining({ id: inv.user.id }), reason: 'Storage' }),
    ]);
    expect(r.history.map((e) => e.action)).toEqual([
      'EVIDENCE_REGISTERED',
      'CUSTODY_TRANSFER_REQUESTED',
      'CUSTODY_TRANSFER_ACCEPTED',
      'INTEGRITY_VERIFIED',
      'REPORT_GENERATED',
    ]);
    expect(r.history[3].details.trigger).toBe('report');

    // The printed head is the report's own log entry, and it is anchored.
    const head = (await h.pool.query('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
    expect(r.chainHead).toMatchObject({ seq: head.seq, entryHash: head.entry_hash });
    expect(r.history[4].seq).toBe(head.seq);
    const anchors = await h.pool.query('SELECT head_seq, reason FROM audit_anchors');
    expect(anchors.rows).toEqual([{ head_seq: head.seq, reason: 'report' }]);

    // Storage details never leave the server.
    expect(JSON.stringify(r)).not.toMatch(/storage_name|auth_tag|key_id|"iv"/);
  });

  test('a tampered file is reported as Failed, and the report is still produced', async () => {
    const { custodian, evidence } = await setup();
    tamper.flipStoredByte(await h.storedPath(evidence.id));

    const res = await custodian.api('get', `/api/evidence/${evidence.id}/report`);
    expect(res.status).toBe(200);
    expect(res.body.report.integrity.status).toBe('failed');
    expect(res.body.report.integrity.reasons).toEqual(expect.arrayContaining(['STORED_FILE_CHANGED', 'DECRYPTION_AUTH_FAILED']));
    expect(res.body.report.evidence.integrityStatus).toBe('failed');
    expect(await h.alertsOfType('INTEGRITY_FAILED')).toHaveLength(1);
  });

  test('an investigator not assigned to the case cannot generate it', async () => {
    const { evidence } = await setup();
    const outsider = await h.signedIn('investigator');
    expect((await outsider.api('get', `/api/evidence/${evidence.id}/report`)).status).toBe(403);
    expect(await h.auditActions('REPORT_GENERATED')).toHaveLength(0);
  });
});

describe('the file tamper demo', () => {
  test('after tamper:file, Verify fails and the download is blocked', async () => {
    const { custodian, evidence } = await setup();
    tamper.flipStoredByte(await h.storedPath(evidence.id));

    const verify = await custodian.api('post', `/api/evidence/${evidence.id}/verify`);
    expect(verify.body.result.status).toBe('failed');
    expect((await custodian.api('get', `/api/evidence/${evidence.id}/download`)).status).toBe(409);
  });

  test('after tamper:file --delete, Verify reports the missing file', async () => {
    const { custodian, evidence } = await setup();
    tamper.deleteStoredFile(await h.storedPath(evidence.id));
    const verify = await custodian.api('post', `/api/evidence/${evidence.id}/verify`);
    expect(verify.body.result.reasons).toEqual(['FILE_MISSING']);
  });
});

describe('dashboard', () => {
  test('shows role-aware counts, transfers waiting and open alerts', async () => {
    const { inv, custodian, auditor, evidence } = await setup();
    tamper.flipStoredByte(await h.storedPath(evidence.id));
    await custodian.api('post', `/api/evidence/${evidence.id}/verify`);

    // A second case the investigator is not on: excluded from their counts.
    const admin = await h.signedIn('administrator');
    const other = await admin.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-501', title: 'Other' });
    await h.registerEvidence(admin.api, other.body.case.id);
    await admin.api('post', `/api/evidence/${evidence.id}/transfers`).send({ toUserId: inv.user.id, reason: 'Re-examination' });

    const invDash = (await inv.api('get', '/api/dashboard')).body;
    expect(invDash.cases).toEqual({ open: 1, closed: 0 });
    expect(invDash.evidence).toEqual({ total: 1, verified: 0, unverified: 0, failed: 1 });
    expect(invDash.custody).toMatchObject({ holding: 0, incomingPending: 1, outgoingPending: 0 });
    expect(invDash.alerts).toBeUndefined();

    const custDash = (await custodian.api('get', '/api/dashboard')).body;
    expect(custDash.cases).toEqual({ open: 2, closed: 0 });
    expect(custDash.evidence.total).toBe(2);
    expect(custDash.custody).toMatchObject({ holding: 1, outgoingPending: 1 });

    const audDash = (await auditor.api('get', '/api/dashboard')).body;
    expect(audDash.alerts).toMatchObject({ open: 1, critical: 1 });
    expect(audDash.alerts.latest[0].type).toBe('INTEGRITY_FAILED');
  });
});
