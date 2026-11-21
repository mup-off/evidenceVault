'use strict';

const h = require('./helpers');

beforeEach(h.resetData);
afterAll(h.closeAll);

/** An investigator's case with one registered item, plus a custodian to hand it to. */
async function setup() {
  const inv = await h.signedIn('investigator');
  const custodian = await h.signedIn('custodian');
  const { body } = await inv.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-300', title: 'Fraud' });
  const caseId = body.case.id;
  const evidence = await h.registerEvidence(inv.api, caseId);
  return { inv, custodian, caseId, evidence };
}

const requestTransfer = (actor, evidenceId, toUserId, reason = 'Lodging in the evidence room') =>
  actor.api('post', `/api/evidence/${evidenceId}/transfers`).send({ toUserId, reason });

async function custodianOf(evidenceId) {
  const { rows } = await h.pool.query('SELECT current_custodian_id FROM evidence WHERE id = $1', [evidenceId]);
  return rows[0].current_custodian_id;
}

describe('transfer to a custodian who accepts', () => {
  test('the custodian changes only on acceptance, and both steps are in the history', async () => {
    const { inv, custodian, evidence } = await setup();

    const req = await requestTransfer(inv, evidence.id, custodian.user.id);
    expect(req.status).toBe(201);
    expect(req.body.transfer).toMatchObject({
      status: 'pending',
      from: { id: inv.user.id },
      to: { id: custodian.user.id },
      reason: 'Lodging in the evidence room',
      reassignment: false,
    });
    expect(await custodianOf(evidence.id)).toBe(inv.user.id); // not yet

    // The recipient sees it waiting on the dashboard.
    const dash = await custodian.api('get', '/api/dashboard');
    expect(dash.body.custody.incomingPending).toBe(1);
    expect(dash.body.custody.waitingForYou[0].evidenceCode).toBe(evidence.evidenceCode);

    const accept = await custodian.api('post', `/api/transfers/${req.body.transfer.id}/accept`).send({ note: 'Sealed bag 7' });
    expect(accept.status).toBe(200);
    expect(accept.body.transfer).toMatchObject({ status: 'accepted', decidedBy: { id: custodian.user.id }, decisionNote: 'Sealed bag 7' });
    expect(await custodianOf(evidence.id)).toBe(custodian.user.id);

    const history = await inv.api('get', `/api/evidence/${evidence.id}/history`);
    const actions = history.body.history.map((e) => e.action);
    expect(actions).toEqual(['EVIDENCE_REGISTERED', 'CUSTODY_TRANSFER_REQUESTED', 'CUSTODY_TRANSFER_ACCEPTED']);
    expect(history.body.history[2]).toMatchObject({ userId: custodian.user.id, userName: custodian.user.full_name });

    const list = await inv.api('get', `/api/evidence/${evidence.id}/transfers`);
    expect(list.body.transfers).toHaveLength(1);
  });

  test('the new holder can pass it on, and the previous holder no longer can', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    await custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`);

    const admin = await h.signedIn('administrator');
    expect((await requestTransfer(inv, evidence.id, admin.user.id)).status).toBe(403);
    expect((await requestTransfer(custodian, evidence.id, admin.user.id)).status).toBe(201);
  });
});

describe('rejecting and cancelling', () => {
  test('a rejected transfer leaves the custodian unchanged', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    const res = await custodian.api('post', `/api/transfers/${t.body.transfer.id}/reject`).send({ note: 'Seal broken' });

    expect(res.status).toBe(200);
    expect(res.body.transfer.status).toBe('rejected');
    expect(await custodianOf(evidence.id)).toBe(inv.user.id);
    expect(await h.auditActions('CUSTODY_TRANSFER_REJECTED')).toHaveLength(1);
  });

  test('the requester can cancel; afterwards a new request is allowed', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    const res = await inv.api('post', `/api/transfers/${t.body.transfer.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.transfer.status).toBe('cancelled');
    expect((await requestTransfer(inv, evidence.id, custodian.user.id)).status).toBe(201);
  });

  test('a decided transfer cannot be decided again', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    await custodian.api('post', `/api/transfers/${t.body.transfer.id}/reject`);
    expect((await custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`)).status).toBe(409);
    expect(await custodianOf(evidence.id)).toBe(inv.user.id);
  });

  test('the database refuses to change a decided transfer, even for the app role', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    await custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`);
    await expect(
      h.pool.query("UPDATE custody_transfers SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = $1", [
        t.body.transfer.id,
      ]),
    ).rejects.toThrow(/already accepted/);
    await expect(h.pool.query('DELETE FROM custody_transfers')).rejects.toThrow(/permission denied/);
  });
});

describe('who may request and decide', () => {
  test('someone who does not hold the item is refused, logged and alerted', async () => {
    const { custodian, evidence } = await setup();
    const other = await h.signedIn('custodian');
    const res = await requestTransfer(custodian, evidence.id, other.user.id);

    expect(res.status).toBe(403);
    const denied = await h.auditActions('ACCESS_DENIED');
    expect(denied).toHaveLength(1);
    expect(denied[0].details.reason).toMatch(/does not hold/);
    expect(await h.alertsOfType('ACCESS_DENIED')).toHaveLength(1);
    expect(await h.pool.query('SELECT 1 FROM custody_transfers')).toHaveProperty('rowCount', 0);
  });

  test('an auditor cannot request transfers', async () => {
    const { custodian, evidence } = await setup();
    const auditor = await h.signedIn('auditor');
    expect((await requestTransfer(auditor, evidence.id, custodian.user.id)).status).toBe(403);
  });

  test('only the recipient may accept or reject', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    const admin = await h.signedIn('administrator');

    expect((await inv.api('post', `/api/transfers/${t.body.transfer.id}/accept`)).status).toBe(403);
    expect((await admin.api('post', `/api/transfers/${t.body.transfer.id}/accept`)).status).toBe(403);
    expect((await admin.api('post', `/api/transfers/${t.body.transfer.id}/reject`)).status).toBe(403);
    expect(await custodianOf(evidence.id)).toBe(inv.user.id);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(3);
  });

  test('only the requester, holder or an administrator may cancel', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    expect((await custodian.api('post', `/api/transfers/${t.body.transfer.id}/cancel`)).status).toBe(403);
    const admin = await h.signedIn('administrator');
    expect((await admin.api('post', `/api/transfers/${t.body.transfer.id}/cancel`)).status).toBe(200);
  });

  test('a reason is required', async () => {
    const { inv, custodian, evidence } = await setup();
    const res = await inv.api('post', `/api/evidence/${evidence.id}/transfers`).send({ toUserId: custodian.user.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  test('recipients must be able to hold the item', async () => {
    const { inv, caseId, evidence } = await setup();
    const auditor = await h.signedIn('auditor');
    const outsider = await h.signedIn('investigator');
    const inactive = await h.createUser('custodian', { active: false });

    expect((await requestTransfer(inv, evidence.id, auditor.user.id)).status).toBe(400);
    expect((await requestTransfer(inv, evidence.id, outsider.user.id)).body.error).toMatch(/not assigned/);
    expect((await requestTransfer(inv, evidence.id, inactive.id)).status).toBe(400);
    expect((await requestTransfer(inv, evidence.id, inv.user.id)).status).toBe(400);
    expect((await requestTransfer(inv, evidence.id, 999999)).status).toBe(404);

    // Once assigned to the case, the second investigator can receive it.
    await inv.api('post', `/api/cases/${caseId}/members`).send({ userId: outsider.user.id });
    expect((await requestTransfer(inv, evidence.id, outsider.user.id)).status).toBe(201);
  });

  test('an investigator removed from the case before accepting cannot accept', async () => {
    const { inv, caseId, evidence } = await setup();
    const second = await h.signedIn('investigator');
    await inv.api('post', `/api/cases/${caseId}/members`).send({ userId: second.user.id });
    const t = await requestTransfer(inv, evidence.id, second.user.id);
    await inv.api('delete', `/api/cases/${caseId}/members/${second.user.id}`);

    expect((await second.api('post', `/api/transfers/${t.body.transfer.id}/accept`)).status).toBe(400);
    expect(await custodianOf(evidence.id)).toBe(inv.user.id);
  });
});

describe('administrator reassignment', () => {
  test('an administrator can reassign any item, with a reason, logged as CUSTODY_REASSIGNED', async () => {
    const { inv, custodian, evidence } = await setup();
    const admin = await h.signedIn('administrator');

    const res = await requestTransfer(admin, evidence.id, custodian.user.id, 'Investigator on leave');
    expect(res.status).toBe(201);
    expect(res.body.transfer).toMatchObject({
      from: { id: inv.user.id },
      requestedBy: { id: admin.user.id },
      reassignment: true,
    });

    const logged = await h.auditActions('CUSTODY_REASSIGNED');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ user_id: admin.user.id });
    expect(logged[0].details).toMatchObject({ reason: 'Investigator on leave', fromUserId: inv.user.id, toUserId: custodian.user.id });

    // The recipient still has to accept.
    expect(await custodianOf(evidence.id)).toBe(inv.user.id);
    await custodian.api('post', `/api/transfers/${res.body.transfer.id}/accept`);
    expect(await custodianOf(evidence.id)).toBe(custodian.user.id);
  });

  test('a reassignment without a reason is refused', async () => {
    const { custodian, evidence } = await setup();
    const admin = await h.signedIn('administrator');
    expect((await requestTransfer(admin, evidence.id, custodian.user.id, '   ')).status).toBe(400);
  });
});

describe('closed cases', () => {
  test('refuse new transfer requests', async () => {
    const { inv, custodian, caseId, evidence } = await setup();
    await inv.api('patch', `/api/cases/${caseId}`).send({ status: 'closed' });
    const res = await requestTransfer(inv, evidence.id, custodian.user.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/closed/);
  });

  test('a pending transfer cannot be accepted after the case closes, but can be rejected', async () => {
    const { inv, custodian, caseId, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    await inv.api('patch', `/api/cases/${caseId}`).send({ status: 'closed' });

    expect((await custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`)).status).toBe(409);
    expect((await custodian.api('post', `/api/transfers/${t.body.transfer.id}/reject`)).status).toBe(200);
    expect(await custodianOf(evidence.id)).toBe(inv.user.id);
  });
});

describe('one transfer at a time', () => {
  test('a second request while one is pending is refused', async () => {
    const { inv, custodian, evidence } = await setup();
    const other = await h.signedIn('custodian');
    expect((await requestTransfer(inv, evidence.id, custodian.user.id)).status).toBe(201);
    const res = await requestTransfer(inv, evidence.id, other.user.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending transfer/);
  });

  test('two simultaneous requests for the same item: only one is created', async () => {
    const { inv, custodian, evidence } = await setup();
    const other = await h.signedIn('custodian');
    const results = await Promise.all([
      requestTransfer(inv, evidence.id, custodian.user.id),
      requestTransfer(inv, evidence.id, other.user.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await h.pool.query("SELECT 1 FROM custody_transfers WHERE status = 'pending'")).rowCount).toBe(1);
  });

  test('two simultaneous accepts of the same transfer: only one succeeds', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    const url = `/api/transfers/${t.body.transfer.id}/accept`;

    const results = await Promise.all([1, 2, 3].map(() => custodian.api('post', url)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await h.auditActions('CUSTODY_TRANSFER_ACCEPTED')).toHaveLength(1);
    expect(await custodianOf(evidence.id)).toBe(custodian.user.id);
  });

  test('an accept racing a cancel: exactly one of them wins', async () => {
    const { inv, custodian, evidence } = await setup();
    const t = await requestTransfer(inv, evidence.id, custodian.user.id);
    const [accept, cancel] = await Promise.all([
      custodian.api('post', `/api/transfers/${t.body.transfer.id}/accept`),
      inv.api('post', `/api/transfers/${t.body.transfer.id}/cancel`),
    ]);
    expect([accept.status, cancel.status].sort()).toEqual([200, 409]);
    const expectedHolder = accept.status === 200 ? custodian.user.id : inv.user.id;
    expect(await custodianOf(evidence.id)).toBe(expectedHolder);
  });
});

describe('listing transfers', () => {
  test('incoming and outgoing lists; only administrators and auditors may list all', async () => {
    const { inv, custodian, evidence } = await setup();
    await requestTransfer(inv, evidence.id, custodian.user.id);

    expect((await custodian.api('get', '/api/transfers?direction=incoming&status=pending')).body.transfers).toHaveLength(1);
    expect((await custodian.api('get', '/api/transfers?direction=outgoing')).body.transfers).toHaveLength(0);
    expect((await inv.api('get', '/api/transfers?direction=outgoing')).body.transfers).toHaveLength(1);

    expect((await inv.api('get', '/api/transfers?direction=all')).status).toBe(403);
    const auditor = await h.signedIn('auditor');
    expect((await auditor.api('get', '/api/transfers?direction=all')).body.transfers).toHaveLength(1);
  });

  test('an investigator not on the case cannot see its transfers or history', async () => {
    const { evidence } = await setup();
    const outsider = await h.signedIn('investigator');
    expect((await outsider.api('get', `/api/evidence/${evidence.id}/transfers`)).status).toBe(403);
    expect((await outsider.api('get', `/api/evidence/${evidence.id}/history`)).status).toBe(403);
  });
});
