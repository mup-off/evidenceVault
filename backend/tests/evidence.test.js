'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers');

beforeEach(h.resetData);
afterAll(h.closeAll);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const year = new Date().getFullYear();

// A recognisable "photo": if encryption failed, this text would appear on disk.
const PHOTO = Buffer.concat([Buffer.from('FAKE-JPEG-HEADER screenshot of threatening WhatsApp message '), crypto.randomBytes(4096)]);

async function setup() {
  const inv = await h.signedIn('investigator');
  const { body } = await inv.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-100', title: 'Cyber harassment' });
  return { inv, caseId: body.case.id };
}

function register(api, caseId, { file = PHOTO, filename = 'whatsapp.jpg', title = 'WhatsApp screenshot', fields = {} } = {}) {
  let req = api('post', '/api/evidence').field('caseId', String(caseId)).field('title', title);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file, { filename, contentType: 'image/jpeg' });
}

async function storedPath(evidenceId) {
  const { rows } = await h.ownerPool.query('SELECT storage_name FROM evidence WHERE id = $1', [evidenceId]);
  return path.join(h.testEnv.evidenceDir, rows[0].storage_name);
}

async function flipOneByte(evidenceId) {
  const file = await storedPath(evidenceId);
  fs.chmodSync(file, 0o644);
  const data = fs.readFileSync(file);
  data[Math.floor(data.length / 2)] ^= 0x01;
  fs.writeFileSync(file, data);
  fs.chmodSync(file, 0o444);
}

describe('registering evidence', () => {
  test('records the SHA-256, stores the file encrypted and read-only, and logs it', async () => {
    const { inv, caseId } = await setup();
    const res = await register(inv.api, caseId, {
      fields: { collectedAt: '2026-11-20T10:30:00Z', collectedBy: 'Det. Mugisha', collectionLocation: 'Kicukiro' },
    });

    expect(res.status).toBe(201);
    const ev = res.body.evidence;
    expect(ev.evidenceCode).toBe(`EV-${year}-000001`);
    expect(ev.sha256).toBe(sha(PHOTO));
    expect(ev.sizeBytes).toBe(PHOTO.length);
    expect(ev.currentCustodianId).toBe(inv.user.id);
    expect(ev.integrityStatus).toBe('unverified');
    expect(ev.collectionMetadata).toEqual({
      collectedAt: '2026-11-20T10:30:00.000Z',
      collectedBy: 'Det. Mugisha',
      collectionLocation: 'Kicukiro',
    });
    expect(res.body.warnings).toEqual([]);

    // The browser never sees how or where the file is stored.
    for (const secret of ['storage_name', 'storageName', 'key_id', 'keyId', 'iv', 'auth_tag', 'authTag']) {
      expect(ev).not.toHaveProperty(secret);
    }

    // On disk: encrypted, unreadable, read-only, and matching the recorded stored-file hash.
    const file = await storedPath(ev.id);
    const onDisk = fs.readFileSync(file);
    expect(onDisk.includes(Buffer.from('WhatsApp'))).toBe(false);
    expect(onDisk.equals(PHOTO)).toBe(false);
    expect(sha(onDisk)).toBe(ev.storedFileSha256);
    expect(() => fs.writeFileSync(file, 'overwrite')).toThrow();

    const logged = await h.auditActions('EVIDENCE_REGISTERED');
    expect(logged).toHaveLength(1);
    expect(logged[0].details).toMatchObject({ evidenceCode: ev.evidenceCode, sha256: sha(PHOTO) });
  });

  test('evidence codes count up within the year', async () => {
    const { inv, caseId } = await setup();
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await register(inv.api, caseId, { file: crypto.randomBytes(100) });
      codes.push(res.body.evidence.evidenceCode);
    }
    expect(codes).toEqual([`EV-${year}-000001`, `EV-${year}-000002`, `EV-${year}-000003`]);
  });

  test('non-ASCII file names are kept', async () => {
    const { inv, caseId } = await setup();
    const res = await register(inv.api, caseId, { filename: "ifoto_y'ikirego_é.jpg" });
    expect(res.body.evidence.originalName).toBe("ifoto_y'ikirego_é.jpg");
  });

  test('uploading the same file twice warns of the duplicate', async () => {
    const { inv, caseId } = await setup();
    await register(inv.api, caseId);
    const second = await register(inv.api, caseId, { title: 'Same screenshot again' });

    expect(second.status).toBe(201);
    expect(second.body.warnings).toHaveLength(1);
    expect(second.body.warnings[0]).toMatchObject({
      type: 'DUPLICATE_FILE',
      existing: [{ evidenceCode: `EV-${year}-000001`, caseNumber: 'RIB-2026-100' }],
    });
    expect(second.body.warnings[0].allCodes).toBeUndefined();
  });

  test('the duplicate warning does not reveal items in cases the uploader cannot see', async () => {
    const { inv, caseId } = await setup();
    await register(inv.api, caseId);

    const other = await h.signedIn('investigator');
    const { body } = await other.api('post', '/api/cases').send({ caseNumber: 'RIB-2026-200', title: 'Other case' });
    const res = await register(other.api, body.case.id);

    expect(res.body.warnings[0].existing).toEqual([]);
    expect(res.body.warnings[0].message).not.toMatch(/EV-|RIB-2026-100/);
  });

  test.each(['custodian', 'auditor'])('a %s cannot register evidence', async (role) => {
    const { caseId } = await setup();
    const user = await h.signedIn(role);
    expect((await register(user.api, caseId)).status).toBe(403);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(1);
  });

  test('an investigator cannot register evidence on a case they are not assigned to', async () => {
    const { caseId } = await setup();
    const outsider = await h.signedIn('investigator');
    expect((await register(outsider.api, caseId)).status).toBe(403);
    expect(await h.alertsOfType('ACCESS_DENIED')).toHaveLength(1);
    expect(fs.existsSync(h.testEnv.evidenceDir) ? fs.readdirSync(h.testEnv.evidenceDir) : []).toEqual([]);
  });

  test('a closed case refuses new evidence', async () => {
    const { inv, caseId } = await setup();
    await inv.api('patch', `/api/cases/${caseId}`).send({ status: 'closed' });
    const res = await register(inv.api, caseId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/closed/);
  });

  test('bad input is rejected', async () => {
    const { inv, caseId } = await setup();
    const noFile = await inv.api('post', '/api/evidence').field('caseId', String(caseId)).field('title', 'x');
    expect(noFile.status).toBe(400);
    expect((await register(inv.api, caseId, { title: '' })).status).toBe(400);
    expect((await register(inv.api, caseId, { fields: { collectedAt: 'yesterday-ish' } })).status).toBe(400);
    expect((await register(inv.api, caseId, { fields: { collectedAt: '2099-01-01T00:00:00Z' } })).status).toBe(400);
  });

  test('files over the size limit are rejected with 413', async () => {
    const { inv, caseId } = await setup();
    const res = await register(inv.api, caseId, { file: Buffer.alloc(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });
});

describe('integrity checks', () => {
  test('an untouched file verifies: hashes match, status Verified', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);

    const res = await inv.api('post', `/api/evidence/${body.evidence.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('verified');
    expect(res.body.result.current.sha256).toBe(res.body.result.recorded.sha256);
    expect(res.body.result.current.storedFileSha256).toBe(res.body.result.recorded.storedFileSha256);
    expect(res.body.evidence.integrityStatus).toBe('verified');
    expect(res.body.evidence.lastVerifiedAt).toEqual(expect.any(String));
    expect(await h.auditActions('INTEGRITY_VERIFIED')).toHaveLength(1);
  });

  test('flipping one byte in the stored file fails the check and raises a critical alert', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    await flipOneByte(body.evidence.id);

    const res = await inv.api('post', `/api/evidence/${body.evidence.id}/verify`);
    const { result } = res.body;
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual(['STORED_FILE_CHANGED', 'DECRYPTION_AUTH_FAILED']);
    expect(result.current.storedFileSha256).not.toBe(result.recorded.storedFileSha256);
    expect(result.summary).toMatch(/decryption authentication failed/);
    expect(res.body.evidence.integrityStatus).toBe('failed');

    const alerts = await h.alertsOfType('INTEGRITY_FAILED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', evidence_id: body.evidence.id });
    expect(await h.auditActions('INTEGRITY_FAILED')).toHaveLength(1);
  });

  test('a missing stored file fails the check', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    const file = await storedPath(body.evidence.id);
    fs.chmodSync(file, 0o644);
    fs.rmSync(file);

    const res = await inv.api('post', `/api/evidence/${body.evidence.id}/verify`);
    expect(res.body.result).toMatchObject({ status: 'failed', reasons: ['FILE_MISSING'] });
    expect(await h.alertsOfType('INTEGRITY_FAILED')).toHaveLength(1);
  });

  test('auditors and custodians can verify any item', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    for (const role of ['auditor', 'custodian']) {
      const user = await h.signedIn(role);
      expect((await user.api('post', `/api/evidence/${body.evidence.id}/verify`)).status).toBe(200);
    }
  });
});

describe('downloading evidence', () => {
  test('an untouched file downloads byte-for-byte after a fresh check', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);

    const res = await inv.api('get', `/api/evidence/${body.evidence.id}/download`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, PHOTO)).toBe(0);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="whatsapp.jpg"/);
    expect(res.headers['x-evidence-sha256']).toBe(sha(PHOTO));
    expect(await h.auditActions('INTEGRITY_VERIFIED')).toHaveLength(1);
    expect(await h.auditActions('EVIDENCE_DOWNLOADED')).toHaveLength(1);
  });

  test('a tampered file cannot be downloaded', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    await flipOneByte(body.evidence.id);

    const res = await inv.api('get', `/api/evidence/${body.evidence.id}/download`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Download blocked/);
    expect(res.body.result.status).toBe('failed');
    expect(await h.auditActions('DOWNLOAD_BLOCKED')).toHaveLength(1);
    expect(await h.auditActions('EVIDENCE_DOWNLOADED')).toHaveLength(0);
  });

  test('an auditor is refused with 403, and the refusal is logged', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    const auditor = await h.signedIn('auditor');

    expect((await auditor.api('get', `/api/evidence/${body.evidence.id}/download`)).status).toBe(403);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(1);
  });

  test('a custodian may download', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    const custodian = await h.signedIn('custodian');
    expect((await custodian.api('get', `/api/evidence/${body.evidence.id}/download`)).status).toBe(200);
  });
});

describe('viewing and searching evidence', () => {
  test('an investigator not on the case cannot view, verify or download its evidence', async () => {
    const { inv, caseId } = await setup();
    const { body } = await register(inv.api, caseId);
    const outsider = await h.signedIn('investigator');
    const id = body.evidence.id;

    expect((await outsider.api('get', `/api/evidence/${id}`)).status).toBe(403);
    expect((await outsider.api('post', `/api/evidence/${id}/verify`)).status).toBe(403);
    expect((await outsider.api('get', `/api/evidence/${id}/download`)).status).toBe(403);
    expect((await outsider.api('get', '/api/evidence')).body.evidence).toEqual([]);
    expect(await h.auditActions('ACCESS_DENIED')).toHaveLength(3);
  });

  test('search matches code, title, case number and hash prefix', async () => {
    const { inv, caseId } = await setup();
    await register(inv.api, caseId, { title: 'WhatsApp screenshot' });
    const other = Buffer.from('bank statement pdf');
    await register(inv.api, caseId, { title: 'Bank statement', file: other, filename: 'statement.pdf' });

    const titles = async (q) =>
      (await inv.api('get', `/api/evidence?q=${encodeURIComponent(q)}`)).body.evidence.map((e) => e.title).sort();
    expect(await titles('bank')).toEqual(['Bank statement']);
    expect(await titles(`EV-${year}-000001`)).toEqual(['WhatsApp screenshot']);
    expect(await titles('RIB-2026-100')).toEqual(['Bank statement', 'WhatsApp screenshot']);
    expect(await titles(sha(other).slice(0, 12))).toEqual(['Bank statement']);
  });
});

describe('protection of recorded values', () => {
  test('the API database role cannot rewrite hashes or delete evidence rows', async () => {
    const { inv, caseId } = await setup();
    await register(inv.api, caseId);
    await expect(h.pool.query("UPDATE evidence SET sha256 = repeat('0', 64)")).rejects.toThrow(/permission denied/);
    await expect(h.pool.query('DELETE FROM evidence')).rejects.toThrow(/permission denied/);
  });
});
