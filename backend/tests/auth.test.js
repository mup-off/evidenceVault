'use strict';

const h = require('./helpers');
const audit = require('../src/services/audit');

beforeEach(h.resetData);
afterAll(h.closeAll);

const login = (email, password) => h.request(h.app).post('/api/auth/login').send({ email, password });

describe('sign-in', () => {
  test('correct password returns a token and the user, never the password hash', async () => {
    const user = await h.createUser('investigator');
    const res = await login(user.email, user.password);

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, role: 'investigator' });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(await h.auditActions('LOGIN_SUCCESS')).toHaveLength(1);
  });

  test('email is case-insensitive', async () => {
    const user = await h.createUser('auditor');
    const res = await login(user.email.toUpperCase(), user.password);
    expect(res.status).toBe(200);
  });

  test('wrong password and unknown email give the same 401 message', async () => {
    const user = await h.createUser('custodian');
    const wrong = await login(user.email, 'not-the-password');
    const unknown = await login('nobody@test.local', 'whatever-123');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
    expect(await h.auditActions('LOGIN_FAILED')).toHaveLength(2);
  });

  test('a deactivated account cannot sign in', async () => {
    const user = await h.createUser('investigator', { active: false });
    const res = await login(user.email, user.password);
    expect(res.status).toBe(401);
  });

  test('missing fields are rejected with 400', async () => {
    expect((await login('', 'x')).status).toBe(400);
    expect((await login('a@b.co', '')).status).toBe(400);
  });
});

describe('account lockout', () => {
  test('five wrong passwords lock the account for 15 minutes and raise an alert', async () => {
    const user = await h.createUser('investigator');

    for (let i = 1; i <= 4; i += 1) {
      expect((await login(user.email, 'wrong-password')).status).toBe(401);
    }
    const fifth = await login(user.email, 'wrong-password');
    expect(fifth.status).toBe(423);

    const minutes = (new Date(fifth.body.lockedUntil) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    // Even the right password is refused while locked.
    expect((await login(user.email, user.password)).status).toBe(423);

    expect(await h.auditActions('ACCOUNT_LOCKED')).toHaveLength(1);
    expect(await h.auditActions('LOGIN_REFUSED_LOCKED')).toHaveLength(1);
    const lockAlerts = await h.alertsOfType('ACCOUNT_LOCKED');
    expect(lockAlerts).toHaveLength(1);
    expect(lockAlerts[0]).toMatchObject({ severity: 'warning', user_id: user.id });
  });

  test('the account opens again once the lock expires', async () => {
    const user = await h.createUser('investigator');
    for (let i = 0; i < 5; i += 1) await login(user.email, 'wrong-password');

    await h.ownerPool.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [user.id]);
    expect((await login(user.email, user.password)).status).toBe(200);
  });

  test('a successful sign-in resets the failure counter', async () => {
    const user = await h.createUser('investigator');
    for (let i = 0; i < 4; i += 1) await login(user.email, 'wrong-password');
    expect((await login(user.email, user.password)).status).toBe(200);

    // Four more failures are needed again before the next lock.
    for (let i = 0; i < 4; i += 1) expect((await login(user.email, 'wrong-password')).status).toBe(401);
  });
});

describe('API root', () => {
  test('/api describes the API; unknown paths give 404', async () => {
    const root = await h.request(h.app).get('/api');
    expect(root.status).toBe(200);
    expect(root.body.health).toBe('/api/health');
    expect((await h.request(h.app).get('/api/nope')).status).toBe(404);
  });
});

describe('sessions', () => {
  test('requests without a valid token are refused', async () => {
    expect((await h.request(h.app).get('/api/auth/me')).status).toBe(401);
    const res = await h.request(h.app).get('/api/auth/me').set('Authorization', 'Bearer not-a-token');
    expect(res.status).toBe(401);
  });

  test('/api/auth/me returns the signed-in user', async () => {
    const { api, user } = await h.signedIn('auditor');
    const res = await api('get', '/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, role: 'auditor' });
  });

  test('deactivating a signed-in user stops their token at once', async () => {
    const admin = await h.signedIn('administrator');
    const victim = await h.signedIn('investigator');
    expect((await victim.api('get', '/api/cases')).status).toBe(200);

    const res = await admin.api('patch', `/api/users/${victim.user.id}`).send({ active: false });
    expect(res.status).toBe(200);
    expect((await victim.api('get', '/api/cases')).status).toBe(401);
  });

  test('a role change takes effect without signing in again', async () => {
    const admin = await h.signedIn('administrator');
    const target = await h.signedIn('custodian');
    expect((await target.api('post', '/api/cases').send({ caseNumber: 'C-1', title: 'x' })).status).toBe(403);

    await admin.api('patch', `/api/users/${target.user.id}`).send({ role: 'investigator' });
    expect((await target.api('post', '/api/cases').send({ caseNumber: 'C-1', title: 'x' })).status).toBe(201);
  });

  test('a password reset by an administrator revokes old tokens', async () => {
    const admin = await h.signedIn('administrator');
    const target = await h.signedIn('investigator');
    await admin.api('patch', `/api/users/${target.user.id}`).send({ password: 'A-brand-new-password' });

    expect((await target.api('get', '/api/auth/me')).status).toBe(401);
    expect((await login(target.user.email, 'A-brand-new-password')).status).toBe(200);
  });
});

describe('audit log', () => {
  test('entries form an HMAC chain that recomputes exactly from the stored rows', async () => {
    const user = await h.createUser('investigator');
    await login(user.email, 'wrong-password');
    await login(user.email, user.password);
    await login('nobody@test.local', 'whatever-123');

    const { rows } = await h.pool.query('SELECT * FROM audit_log ORDER BY seq');
    expect(rows.length).toBeGreaterThanOrEqual(3);

    let prev = audit.GENESIS_HASH;
    for (const row of rows) {
      expect(row.prev_hash).toBe(prev);
      const recomputed = audit.computeHash({
        prevHash: row.prev_hash,
        ts: row.ts,
        userId: row.user_id,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        details: row.details,
        ip: row.ip,
      });
      expect(recomputed).toBe(row.entry_hash);
      prev = row.entry_hash;
    }
  });

  test('concurrent appends still form a single unbroken chain', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => audit.append({ action: 'TEST_EVENT', details: { i } })));
    const { rows } = await h.pool.query('SELECT prev_hash, entry_hash FROM audit_log ORDER BY seq');
    expect(rows).toHaveLength(20);
    rows.forEach((row, i) => expect(row.prev_hash).toBe(i === 0 ? audit.GENESIS_HASH : rows[i - 1].entry_hash));
  });

  test('the API database role cannot update, delete or truncate the audit log', async () => {
    await audit.append({ action: 'TEST_EVENT' });
    await expect(h.pool.query("UPDATE audit_log SET action = 'EDITED'")).rejects.toThrow(/permission denied/);
    await expect(h.pool.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
    await expect(h.pool.query('TRUNCATE audit_log')).rejects.toThrow(/permission denied/);
  });
});
