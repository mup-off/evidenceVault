'use strict';

const h = require('./helpers');
const tamper = require('../scripts/tamper/lib');
const audit = require('../src/services/audit');

beforeEach(h.resetData);
afterAll(h.closeAll);

/** Some realistic activity: a case, two items, a custody transfer. Returns the actors. */
async function activity() {
  const admin = await h.signedIn('administrator');
  const auditor = await h.signedIn('auditor');
  const inv = await h.signedIn('investigator');
  const custodian = await h.signedIn('custodian');
  const { body } = await inv.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-400', title: 'Extortion' });
  const ev1 = await h.registerEvidence(inv.api, body.case.id, { title: 'Phone dump' });
  await h.registerEvidence(inv.api, body.case.id, { title: 'Email export' });
  await inv.api('post', `/api/evidence/${ev1.id}/verify`);
  const t = await inv.api('post', `/api/evidence/${ev1.id}/transfers`).send({ toUserId: custodian.user.id, reason: 'Storage' });
  await custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`);
  return { admin, auditor, inv, custodian, ev1 };
}

const verifyChain = (actor) => actor.api('post', '/api/audit/verify');

async function withOwner(fn) {
  const client = await h.ownerPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

describe('an untouched chain', () => {
  test('verifies intact, logs the check and anchors the head', async () => {
    const { auditor } = await activity();
    const { rows } = await h.pool.query('SELECT count(*)::int AS n, max(seq) AS head FROM audit_log');

    const res = await verifyChain(auditor);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ intact: true, entriesChecked: rows[0].n, brokenCount: 0, firstBreak: null });
    expect(res.body.result.head.seq).toBe(rows[0].head);

    // The check itself is logged, and the new head (that log entry) is anchored.
    const logged = await h.auditActions('AUDIT_CHAIN_VERIFIED');
    expect(logged).toHaveLength(1);
    expect(res.body.anchor.seq).toBe(logged[0].seq);
    expect(res.body.anchor.entryHash).toBe(logged[0].entry_hash);

    // Checking again includes the previous check's entry and anchor.
    const again = await verifyChain(auditor);
    expect(again.body.result).toMatchObject({ intact: true, entriesChecked: rows[0].n + 1 });
    expect(again.body.result.anchors.checked).toBe(1);
  });

  test('an empty log is intact', async () => {
    const result = await audit.verifyChain();
    expect(result).toMatchObject({ intact: true, entriesChecked: 0, head: null });
  });

  test('entries are read back in batches without breaking the chain', async () => {
    await activity();
    const result = await audit.verifyChain({ batchSize: 3 });
    expect(result.intact).toBe(true);
    expect(result.entriesChecked).toBeGreaterThan(6);
  });

  test('only administrators and auditors may read or check the log', async () => {
    const { inv, custodian } = await activity();
    for (const actor of [inv, custodian]) {
      expect((await actor.api('get', '/api/audit')).status).toBe(403);
      expect((await verifyChain(actor)).status).toBe(403);
    }
  });

  test('the log can be listed and filtered, newest first', async () => {
    const { admin, ev1 } = await activity();
    const res = await admin.api('get', `/api/audit?entity=evidence&entityId=${ev1.id}`);
    expect(res.status).toBe(200);
    const actions = res.body.entries.map((e) => e.action);
    expect(actions[0]).toBe('CUSTODY_TRANSFER_ACCEPTED');
    expect(actions[actions.length - 1]).toBe('EVIDENCE_REGISTERED');
    expect(res.body.head.seq).toBeGreaterThan(0);

    const page = await admin.api('get', '/api/audit?limit=2');
    expect(page.body.entries).toHaveLength(2);
    const next = await admin.api('get', `/api/audit?limit=2&beforeSeq=${page.body.nextBeforeSeq}`);
    expect(next.body.entries[0].seq).toBeLessThan(page.body.entries[1].seq);
  });
});

describe('tampering with the audit log', () => {
  test('editing one entry breaks the chain at exactly that entry', async () => {
    const { auditor } = await activity();
    const target = await withOwner((c) => tamper.defaultTargetSeq(c));
    await withOwner((c) => tamper.backdateEntry(c, target));

    const res = await verifyChain(auditor);
    expect(res.body.result.intact).toBe(false);
    expect(res.body.result.brokenCount).toBe(1);
    expect(res.body.result.firstBreak).toMatchObject({ seq: target, action: 'CUSTODY_TRANSFER_ACCEPTED', problem: 'ENTRY_HASH_MISMATCH' });
    expect(res.body.result.summary).toMatch(new RegExp(`#${target}`));
    expect(res.body.anchor).toBeNull(); // a broken chain is never anchored

    expect(await h.auditActions('AUDIT_CHAIN_BROKEN')).toHaveLength(1);
    const alerts = await h.alertsOfType('AUDIT_CHAIN_BROKEN');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('critical');
  });

  test('recomputing later hashes with plain SHA-256 is still detected (no HMAC key)', async () => {
    const { auditor } = await activity();
    const { rows } = await h.pool.query('SELECT max(seq) AS m FROM audit_log');
    const target = 3;
    await withOwner((c) => tamper.backdateAndRecompute(c, target));

    const res = await verifyChain(auditor);
    expect(res.body.result.intact).toBe(false);
    expect(res.body.result.firstBreak).toMatchObject({ seq: target, problem: 'ENTRY_HASH_MISMATCH' });
    expect(res.body.result.brokenCount).toBe(rows[0].m - target + 1);
  });

  test('deleting an entry in the middle breaks the link after it', async () => {
    const { auditor } = await activity();
    await withOwner((c) => tamper.withTriggersOff(c, 'audit_log', (t) => t.query('DELETE FROM audit_log WHERE seq = 4')));
    const res = await verifyChain(auditor);
    expect(res.body.result.firstBreak).toMatchObject({ seq: 5, problem: 'PREVIOUS_HASH_MISMATCH' });
  });

  test('deleting the newest entries is detected through the anchored head', async () => {
    const { auditor, inv, ev1 } = await activity();
    // A report anchors the head...
    const report = await auditor.api('get', `/api/evidence/${ev1.id}/report`);
    const anchoredSeq = report.body.report.chainHead.seq;
    // ...a little more activity happens...
    await inv.api('post', `/api/evidence/${ev1.id}/verify`);
    // ...then someone deletes the newest entries, including the anchored one.
    const deleted = await withOwner((c) => tamper.deleteNewest(c, 3));
    expect(deleted.map((d) => d.seq)).toContain(anchoredSeq);

    const res = await verifyChain(auditor);
    expect(res.body.result.intact).toBe(false);
    expect(res.body.result.brokenCount).toBe(0); // the remaining links are all fine
    expect(res.body.result.anchors.problems).toEqual([
      expect.objectContaining({ seq: anchoredSeq, problem: 'ANCHORED_ENTRY_MISSING' }),
    ]);
  });

  test('a later report cannot paper over deleted entries: every anchor is checked', async () => {
    const { auditor, ev1 } = await activity();
    const first = await auditor.api('get', `/api/evidence/${ev1.id}/report`);
    await withOwner((c) => tamper.deleteNewest(c, 2));
    await auditor.api('get', `/api/evidence/${ev1.id}/report`); // anchors the new, shorter head

    const res = await verifyChain(auditor);
    expect(res.body.result.intact).toBe(false);
    expect(res.body.result.anchors.problems[0]).toMatchObject({
      seq: first.body.report.chainHead.seq,
      problem: 'ANCHORED_ENTRY_MISSING',
    });
  });

  test('a forged anchor is detected', async () => {
    const { auditor, ev1 } = await activity();
    await auditor.api('get', `/api/evidence/${ev1.id}/report`);
    await withOwner((c) =>
      tamper.withTriggersOff(c, 'audit_anchors', (t) => t.query('UPDATE audit_anchors SET head_seq = head_seq - 1')),
    );
    const res = await verifyChain(auditor);
    expect(res.body.result.anchors.problems[0].problem).toBe('ANCHOR_SIGNATURE_INVALID');
  });
});

describe('the database refuses changes to the audit log', () => {
  test.each([
    ['UPDATE', "UPDATE audit_log SET action = 'EDITED'"],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log'],
  ])('%s as the app role is refused', async (op, sql) => {
    await activity();
    await expect(h.pool.query(sql)).rejects.toThrow(/permission denied/);
  });

  test.each([
    ['UPDATE', "UPDATE audit_log SET action = 'EDITED'"],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log CASCADE'],
  ])('%s is refused by the triggers even for the owner role', async (op, sql) => {
    await activity();
    await expect(h.ownerPool.query(sql)).rejects.toThrow(/append-only/);
  });

  test('anchors are append-only too', async () => {
    const { auditor, ev1 } = await activity();
    await auditor.api('get', `/api/evidence/${ev1.id}/report`);
    await expect(h.pool.query('DELETE FROM audit_anchors')).rejects.toThrow(/permission denied/);
    await expect(h.ownerPool.query('DELETE FROM audit_anchors')).rejects.toThrow(/append-only/);
  });
});

describe('alerts', () => {
  test('administrators and auditors see open alerts; only administrators acknowledge them', async () => {
    const { admin, auditor, inv } = await activity();
    const outsiderCase = await admin.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-401', title: 'Hidden' });
    await inv.api('get', `/api/cases/${outsiderCase.body.case.id}`); // denied -> warning alert

    const list = await auditor.api('get', '/api/alerts');
    expect(list.status).toBe(200);
    expect(list.body.alerts).toHaveLength(1);
    const alert = list.body.alerts[0];
    expect(alert).toMatchObject({ type: 'ACCESS_DENIED', severity: 'warning', acknowledged: false });

    expect((await inv.api('get', '/api/alerts')).status).toBe(403);
    expect((await auditor.api('post', `/api/alerts/${alert.id}/acknowledge`)).status).toBe(403);

    const ack = await admin.api('post', `/api/alerts/${alert.id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body.alert).toMatchObject({ acknowledged: true, acknowledgedBy: admin.user.id });
    expect((await admin.api('post', `/api/alerts/${alert.id}/acknowledge`)).status).toBe(409);
    expect(await h.auditActions('ALERT_ACKNOWLEDGED')).toHaveLength(1);

    // New alerts were raised by the refused attempts above; the acknowledged one is gone from "open".
    const open = await admin.api('get', '/api/alerts');
    expect(open.body.alerts.map((a) => a.id)).not.toContain(alert.id);
    const all = await admin.api('get', '/api/alerts?status=all');
    expect(all.body.alerts.map((a) => a.id)).toContain(alert.id);
  });
});
