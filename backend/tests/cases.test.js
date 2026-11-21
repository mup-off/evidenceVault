'use strict';

const h = require('./helpers');

beforeEach(h.resetData);
afterAll(h.closeAll);

const newCase = (api, caseNumber = 'RIB-2026-001', title = 'Phone fraud in Kigali') =>
  api('post', '/api/cases').send({ caseNumber, title, description: 'Test case' });

describe('creating cases', () => {
  test('an investigator creates a case and is assigned to it automatically', async () => {
    const inv = await h.signedIn('investigator');
    const res = await newCase(inv.api);

    expect(res.status).toBe(201);
    expect(res.body.case).toMatchObject({ caseNumber: 'RIB-2026-001', status: 'open', createdBy: inv.user.id });

    const detail = await inv.api('get', `/api/cases/${res.body.case.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.members.map((m) => m.id)).toEqual([inv.user.id]);
    expect(await h.auditActions('CASE_CREATED')).toHaveLength(1);
  });

  test('an administrator can create a case', async () => {
    const admin = await h.signedIn('administrator');
    expect((await newCase(admin.api)).status).toBe(201);
  });

  test.each(['custodian', 'auditor'])('a %s cannot create a case; the refusal is logged and alerted', async (role) => {
    const user = await h.signedIn(role);
    const res = await newCase(user.api);

    expect(res.status).toBe(403);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(1);
    expect(await h.alertsOfType('ACCESS_DENIED')).toHaveLength(1);
  });

  test('case numbers are unique', async () => {
    const inv = await h.signedIn('investigator');
    await newCase(inv.api);
    expect((await newCase(inv.api)).status).toBe(409);
  });

  test('a case needs a number and a title', async () => {
    const inv = await h.signedIn('investigator');
    expect((await inv.api('post', '/api/cases').send({ title: 'No number' })).status).toBe(400);
    expect((await inv.api('post', '/api/cases').send({ caseNumber: 'X-1' })).status).toBe(400);
  });
});

describe('case-level access', () => {
  test('an investigator not assigned to a case is refused, logged and alerted', async () => {
    const owner = await h.signedIn('investigator');
    const outsider = await h.signedIn('investigator');
    const { body } = await newCase(owner.api);

    const res = await outsider.api('get', `/api/cases/${body.case.id}`);
    expect(res.status).toBe(403);

    const denied = await h.auditActions('ACCESS_DENIED');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ user_id: outsider.user.id, entity: 'case', entity_id: String(body.case.id) });
    const alerts = await h.alertsOfType('ACCESS_DENIED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('warning');
  });

  test.each(['administrator', 'custodian', 'auditor'])('a %s can view any case', async (role) => {
    const owner = await h.signedIn('investigator');
    const viewer = await h.signedIn(role);
    const { body } = await newCase(owner.api);
    expect((await viewer.api('get', `/api/cases/${body.case.id}`)).status).toBe(200);
  });

  test('investigators list only their assigned cases; auditors list all', async () => {
    const a = await h.signedIn('investigator');
    const b = await h.signedIn('investigator');
    const auditor = await h.signedIn('auditor');
    await newCase(a.api, 'A-1');
    await newCase(b.api, 'B-1');
    await newCase(b.api, 'B-2');

    const numbers = async (api) => (await api('get', '/api/cases')).body.cases.map((c) => c.caseNumber).sort();
    expect(await numbers(a.api)).toEqual(['A-1']);
    expect(await numbers(b.api)).toEqual(['B-1', 'B-2']);
    expect(await numbers(auditor.api)).toEqual(['A-1', 'B-1', 'B-2']);
  });

  test('an unknown case gives 404, not 403', async () => {
    const inv = await h.signedIn('investigator');
    expect((await inv.api('get', '/api/cases/999999')).status).toBe(404);
  });
});

describe('case members', () => {
  test('the creating investigator can assign another investigator, who then gains access', async () => {
    const owner = await h.signedIn('investigator');
    const colleague = await h.signedIn('investigator');
    const { body } = await newCase(owner.api);
    const url = `/api/cases/${body.case.id}`;

    expect((await colleague.api('get', url)).status).toBe(403);
    const add = await owner.api('post', `${url}/members`).send({ userId: colleague.user.id });
    expect(add.status).toBe(201);
    expect(add.body.members.map((m) => m.id).sort()).toEqual([owner.user.id, colleague.user.id].sort());
    expect((await colleague.api('get', url)).status).toBe(200);
    expect(await h.auditActions('CASE_MEMBER_ADDED')).toHaveLength(1);
  });

  test('an assigned investigator who did not open the case cannot add members', async () => {
    const owner = await h.signedIn('investigator');
    const member = await h.signedIn('investigator');
    const third = await h.signedIn('investigator');
    const { body } = await newCase(owner.api);
    await owner.api('post', `/api/cases/${body.case.id}/members`).send({ userId: member.user.id });

    const res = await member.api('post', `/api/cases/${body.case.id}/members`).send({ userId: third.user.id });
    expect(res.status).toBe(403);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(1);
  });

  test('only active investigators can be members, and only once', async () => {
    const admin = await h.signedIn('administrator');
    const custodian = await h.createUser('custodian');
    const inactive = await h.createUser('investigator', { active: false });
    const inv = await h.createUser('investigator');
    const { body } = await newCase(admin.api);
    const url = `/api/cases/${body.case.id}/members`;

    expect((await admin.api('post', url).send({ userId: custodian.id })).status).toBe(400);
    expect((await admin.api('post', url).send({ userId: inactive.id })).status).toBe(400);
    expect((await admin.api('post', url).send({ userId: inv.id })).status).toBe(201);
    expect((await admin.api('post', url).send({ userId: inv.id })).status).toBe(409);
  });

  test('members can be removed, but not the investigator who opened the case', async () => {
    const owner = await h.signedIn('investigator');
    const colleague = await h.createUser('investigator');
    const { body } = await newCase(owner.api);
    const url = `/api/cases/${body.case.id}/members`;
    await owner.api('post', url).send({ userId: colleague.id });

    expect((await owner.api('delete', `${url}/${owner.user.id}`)).status).toBe(400);
    const res = await owner.api('delete', `${url}/${colleague.id}`);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => m.id)).toEqual([owner.user.id]);
  });
});

describe('closing cases', () => {
  test('the creator can close a case; only an administrator can reopen it', async () => {
    const owner = await h.signedIn('investigator');
    const admin = await h.signedIn('administrator');
    const { body } = await newCase(owner.api);
    const url = `/api/cases/${body.case.id}`;

    const closed = await owner.api('patch', url).send({ status: 'closed' });
    expect(closed.status).toBe(200);
    expect(closed.body.case.status).toBe('closed');
    expect(closed.body.case.closedAt).toEqual(expect.any(String));

    expect((await owner.api('patch', url).send({ status: 'open' })).status).toBe(403);
    const reopened = await admin.api('patch', url).send({ status: 'open' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.case.closedAt).toBeNull();

    expect(await h.auditActions('CASE_CLOSED')).toHaveLength(1);
    expect(await h.auditActions('CASE_REOPENED')).toHaveLength(1);
  });

  test('custodians cannot change a case', async () => {
    const owner = await h.signedIn('investigator');
    const custodian = await h.signedIn('custodian');
    const { body } = await newCase(owner.api);
    expect((await custodian.api('patch', `/api/cases/${body.case.id}`).send({ title: 'New' })).status).toBe(403);
  });
});
