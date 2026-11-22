'use strict';

// Role matrix: every API route, called by every role, against the
// "Roles and permissions" table in the plan. For each refusal (403) it also
// checks that an ACCESS_DENIED entry was written to the audit log.
//
// Roles in the fixture:
//   admin  administrator
//   inv    investigator who opened the case, is assigned to it and holds the evidence
//   inv2   investigator NOT assigned to the case
//   cus    evidence custodian (recipient of a pending transfer)
//   aud    auditor

const crypto = require('node:crypto');

const h = require('./helpers');
const { signToken } = require('../src/middleware/auth');
const alerts = require('../src/services/alerts');

const ROLES = ['admin', 'inv', 'inv2', 'cus', 'aud'];

async function buildWorld() {
  await h.resetData();
  const u = {};
  for (const [key, role] of [
    ['admin', 'administrator'],
    ['inv', 'investigator'],
    ['inv2', 'investigator'],
    ['cus', 'custodian'],
    ['aud', 'auditor'],
    ['inv3', 'investigator'], // a second assigned investigator, so removing a member can be tested
    ['spare', 'custodian'], // target for user-management calls
  ]) {
    u[key] = await h.createUser(role);
  }
  const tokens = Object.fromEntries(Object.entries(u).map(([k, user]) => [k, signToken(user)]));
  const api = (who, method, url) => {
    const req = h.request(h.app)[method](url);
    return who ? req.set('Authorization', `Bearer ${tokens[who]}`) : req;
  };

  const caseRes = await api('inv', 'post', '/api/cases').send({ caseNumber: 'RIB-PERM-1', title: 'Permission matrix' });
  const caseId = caseRes.body.case.id;
  await api('inv', 'post', `/api/cases/${caseId}/members`).send({ userId: u.inv3.id });

  const evidence = await h.registerEvidence((m, url) => api('inv', m, url), caseId, { title: 'Held by inv' });
  const evidence2 = await h.registerEvidence((m, url) => api('inv', m, url), caseId, { title: 'Pending transfer' });
  const t = await api('inv', 'post', `/api/evidence/${evidence2.id}/transfers`).send({ toUserId: u.cus.id, reason: 'Matrix' });
  const alertId = await alerts.raise({ severity: 'warning', type: 'MATRIX_TEST', message: 'Fixture alert' });

  return { u, api, caseId, evidenceId: evidence.id, transferId: t.body.transfer.id, alertId };
}

const OK = (code) => Object.fromEntries(ROLES.map((r) => [r, code]));
const only = (allowed, code) => Object.fromEntries(ROLES.map((r) => [r, allowed.includes(r) ? code : 403]));

const upload = (req, w, who) =>
  req
    .field('caseId', String(w.caseId))
    .field('title', `Upload by ${who}`)
    .attach('file', crypto.randomBytes(512), { filename: 'matrix.bin', contentType: 'application/octet-stream' });

// Routes that do not change what other calls depend on: one shared fixture.
const READ_ROUTES = [
  { name: 'GET /api/auth/me', method: 'get', path: () => '/api/auth/me', expect: OK(200) },
  { name: 'GET /api/users/directory', method: 'get', path: () => '/api/users/directory', expect: OK(200) },
  { name: 'GET /api/users', method: 'get', path: () => '/api/users', expect: only(['admin'], 200) },
  { name: 'GET /api/users/:id', method: 'get', path: (w) => `/api/users/${w.u.spare.id}`, expect: only(['admin'], 200) },
  { name: 'POST /api/users', method: 'post', path: () => '/api/users', body: (w, who) => ({ fullName: `New ${who}`, email: `new-${who}@test.local`, role: 'auditor', password: 'Correct-Horse-42' }), expect: only(['admin'], 201) },
  { name: 'PATCH /api/users/:id', method: 'patch', path: (w) => `/api/users/${w.u.spare.id}`, body: () => ({ fullName: 'Renamed Spare' }), expect: only(['admin'], 200) },
  { name: 'GET /api/cases', method: 'get', path: () => '/api/cases', expect: OK(200) },
  { name: 'POST /api/cases', method: 'post', path: () => '/api/cases', body: (w, who) => ({ caseNumber: `RIB-NEW-${who}`, title: 'New' }), expect: only(['admin', 'inv', 'inv2'], 201) },
  { name: 'GET /api/cases/:id', method: 'get', path: (w) => `/api/cases/${w.caseId}`, expect: only(['admin', 'inv', 'cus', 'aud'], 200) },
  { name: 'PATCH /api/cases/:id', method: 'patch', path: (w) => `/api/cases/${w.caseId}`, body: () => ({ title: 'Renamed case' }), expect: only(['admin', 'inv'], 200) },
  { name: 'POST /api/evidence', method: 'post', path: () => '/api/evidence', upload: true, expect: only(['admin', 'inv'], 201) },
  { name: 'GET /api/evidence', method: 'get', path: () => '/api/evidence', expect: OK(200) },
  { name: 'GET /api/evidence/:id', method: 'get', path: (w) => `/api/evidence/${w.evidenceId}`, expect: only(['admin', 'inv', 'cus', 'aud'], 200) },
  { name: 'POST /api/evidence/:id/verify', method: 'post', path: (w) => `/api/evidence/${w.evidenceId}/verify`, expect: only(['admin', 'inv', 'cus', 'aud'], 200) },
  { name: 'GET /api/evidence/:id/download', method: 'get', path: (w) => `/api/evidence/${w.evidenceId}/download`, expect: only(['admin', 'inv', 'cus'], 200) },
  { name: 'GET /api/evidence/:id/history', method: 'get', path: (w) => `/api/evidence/${w.evidenceId}/history`, expect: only(['admin', 'inv', 'cus', 'aud'], 200) },
  { name: 'GET /api/evidence/:id/transfers', method: 'get', path: (w) => `/api/evidence/${w.evidenceId}/transfers`, expect: only(['admin', 'inv', 'cus', 'aud'], 200) },
  { name: 'GET /api/evidence/:id/report', method: 'get', path: (w) => `/api/evidence/${w.evidenceId}/report`, expect: only(['admin', 'inv', 'cus', 'aud'], 200) },
  { name: 'GET /api/transfers', method: 'get', path: () => '/api/transfers', expect: OK(200) },
  { name: 'GET /api/transfers?direction=all', method: 'get', path: () => '/api/transfers?direction=all', expect: only(['admin', 'aud'], 200) },
  { name: 'GET /api/audit', method: 'get', path: () => '/api/audit', expect: only(['admin', 'aud'], 200) },
  { name: 'GET /api/audit/head', method: 'get', path: () => '/api/audit/head', expect: only(['admin', 'aud'], 200) },
  { name: 'POST /api/audit/verify', method: 'post', path: () => '/api/audit/verify', expect: only(['admin', 'aud'], 200) },
  { name: 'GET /api/alerts', method: 'get', path: () => '/api/alerts', expect: only(['admin', 'aud'], 200) },
  { name: 'GET /api/dashboard', method: 'get', path: () => '/api/dashboard', expect: OK(200) },
];

// Routes whose success changes the fixture: a fresh fixture for every call.
const WRITE_ROUTES = [
  { name: 'POST /api/cases/:id/members', method: 'post', path: (w) => `/api/cases/${w.caseId}/members`, body: (w) => ({ userId: w.u.inv2.id }), expect: only(['admin', 'inv'], 201) },
  { name: 'DELETE /api/cases/:id/members/:userId', method: 'delete', path: (w) => `/api/cases/${w.caseId}/members/${w.u.inv3.id}`, expect: only(['admin', 'inv'], 200) },
  { name: 'POST /api/evidence/:id/transfers', method: 'post', path: (w) => `/api/evidence/${w.evidenceId}/transfers`, body: (w) => ({ toUserId: w.u.cus.id, reason: 'Matrix request' }), expect: only(['admin', 'inv'], 201) },
  { name: 'POST /api/transfers/:id/accept', method: 'post', path: (w) => `/api/transfers/${w.transferId}/accept`, expect: only(['cus'], 200) },
  { name: 'POST /api/transfers/:id/reject', method: 'post', path: (w) => `/api/transfers/${w.transferId}/reject`, expect: only(['cus'], 200) },
  { name: 'POST /api/transfers/:id/cancel', method: 'post', path: (w) => `/api/transfers/${w.transferId}/cancel`, expect: only(['admin', 'inv'], 200) },
  { name: 'POST /api/alerts/:id/acknowledge', method: 'post', path: (w) => `/api/alerts/${w.alertId}/acknowledge`, expect: only(['admin'], 200) },
];

async function deniedCount() {
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'ACCESS_DENIED'");
  return rows[0].n;
}

async function call(w, route, who) {
  let req = w.api(who, route.method, route.path(w));
  if (route.upload) req = upload(req, w, who);
  else if (route.body) req = req.send(route.body(w, who));
  return req;
}

async function expectOutcome(w, route, who) {
  const expected = route.expect[who];
  const before = await deniedCount();
  const res = await call(w, route, who);
  expect({ route: route.name, role: who, status: res.status }).toEqual({ route: route.name, role: who, status: expected });
  const logged = (await deniedCount()) - before;
  expect({ route: route.name, role: who, accessDeniedLogged: logged }).toEqual({
    route: route.name,
    role: who,
    accessDeniedLogged: expected === 403 ? 1 : 0,
  });
  return res;
}

const cases = (routes) => routes.flatMap((route) => ROLES.map((who) => [route.name, who, route]));

afterAll(h.closeAll);

describe('every route x every role (shared fixture)', () => {
  let w;
  beforeAll(async () => {
    w = await buildWorld();
  });

  test.each(cases(READ_ROUTES))('%s as %s', async (_name, who, route) => {
    await expectOutcome(w, route, who);
  });

  test('an unassigned investigator sees no cases or evidence from that case in lists', async () => {
    const cases = await w.api('inv2', 'get', '/api/cases');
    const evidence = await w.api('inv2', 'get', '/api/evidence');
    expect(cases.body.cases.map((c) => c.caseNumber)).not.toContain('RIB-PERM-1');
    expect(evidence.body.evidence.filter((e) => e.caseId === w.caseId)).toEqual([]);
  });
});

describe('every route x every role (fresh fixture per call)', () => {
  test.each(cases(WRITE_ROUTES))('%s as %s', async (_name, who, route) => {
    const w = await buildWorld();
    await expectOutcome(w, route, who);
  });
});

describe('without a token', () => {
  let w;
  beforeAll(async () => {
    w = await buildWorld();
  });

  test.each([...READ_ROUTES, ...WRITE_ROUTES].map((r) => [r.name, r]))('%s is refused with 401', async (_name, route) => {
    const res = await call(w, route, null);
    expect(res.status).toBe(401);
  });

  test('GET /api/health needs no token', async () => {
    expect((await h.request(h.app).get('/api/health')).status).toBe(200);
  });
});
