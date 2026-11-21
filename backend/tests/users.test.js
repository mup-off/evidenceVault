'use strict';

const h = require('./helpers');

beforeEach(h.resetData);
afterAll(h.closeAll);

describe('user management', () => {
  test('an administrator creates a user who can then sign in', async () => {
    const admin = await h.signedIn('administrator');
    const res = await admin
      .api('post', '/api/users')
      .send({ fullName: 'Aline Uwase', email: 'Aline@Test.Local', role: 'custodian', password: 'Strong-pass-123' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'aline@test.local', role: 'custodian', active: true });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(await h.auditActions('USER_CREATED')).toHaveLength(1);

    const login = await h.request(h.app).post('/api/auth/login').send({ email: 'aline@test.local', password: 'Strong-pass-123' });
    expect(login.status).toBe(200);
  });

  test('input is validated', async () => {
    const admin = await h.signedIn('administrator');
    const base = { fullName: 'X', email: 'x@test.local', role: 'custodian', password: 'Strong-pass-123' };
    expect((await admin.api('post', '/api/users').send({ ...base, password: 'short' })).status).toBe(400);
    expect((await admin.api('post', '/api/users').send({ ...base, role: 'superuser' })).status).toBe(400);
    expect((await admin.api('post', '/api/users').send({ ...base, email: 'not-an-email' })).status).toBe(400);
  });

  test('duplicate emails are rejected', async () => {
    const admin = await h.signedIn('administrator');
    const existing = await h.createUser('auditor');
    const res = await admin
      .api('post', '/api/users')
      .send({ fullName: 'Dup', email: existing.email, role: 'auditor', password: 'Strong-pass-123' });
    expect(res.status).toBe(409);
  });

  test.each(['investigator', 'custodian', 'auditor'])('a %s cannot list or manage users', async (role) => {
    const user = await h.signedIn(role);
    expect((await user.api('get', '/api/users')).status).toBe(403);
    expect((await user.api('patch', `/api/users/${user.user.id}`).send({ role: 'administrator' })).status).toBe(403);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(2);
  });

  test('administrators cannot deactivate or demote themselves', async () => {
    const admin = await h.signedIn('administrator');
    expect((await admin.api('patch', `/api/users/${admin.user.id}`).send({ active: false })).status).toBe(400);
    expect((await admin.api('patch', `/api/users/${admin.user.id}`).send({ role: 'auditor' })).status).toBe(400);
  });

  test('an administrator can unlock a locked account', async () => {
    const admin = await h.signedIn('administrator');
    const user = await h.createUser('investigator');
    for (let i = 0; i < 5; i += 1) {
      await h.request(h.app).post('/api/auth/login').send({ email: user.email, password: 'wrong-password' });
    }
    const listed = await admin.api('get', `/api/users/${user.id}`);
    expect(listed.body.user.lockedUntil).toEqual(expect.any(String));

    const res = await admin.api('patch', `/api/users/${user.id}`).send({ unlock: true });
    expect(res.status).toBe(200);
    expect(res.body.user.lockedUntil).toBeNull();
    expect((await h.login(user)).length).toBeGreaterThan(0);
  });
});

describe('user directory', () => {
  test('any signed-in user can list active users by role, without emails', async () => {
    const inv = await h.signedIn('investigator');
    await h.createUser('investigator');
    await h.createUser('investigator', { active: false });
    await h.createUser('custodian');

    const res = await inv.api('get', '/api/users/directory?role=investigator');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    res.body.users.forEach((u) => {
      expect(u.role).toBe('investigator');
      expect(u.email).toBeUndefined();
    });
  });
});
