'use strict';

// Tampering helpers for the demo and the tests. They act the way someone with
// direct server access would: changing files on disk, or connecting to the
// database as the owner role and switching off the append-only triggers.
// The point of the demo is that EvidenceVault detects every one of these.

const crypto = require('node:crypto');
const fs = require('node:fs');

const { canonicalEntry } = require('../../src/services/audit');

/** Flips one bit in the middle of a stored file. Returns the SHA-256 before and after. */
function flipStoredByte(file) {
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  fs.chmodSync(file, 0o644);
  const data = fs.readFileSync(file);
  const before = sha(data);
  const offset = Math.floor(data.length / 2);
  data[offset] ^= 0x01;
  fs.writeFileSync(file, data);
  fs.chmodSync(file, 0o444);
  return { offset, before, after: sha(data) };
}

function deleteStoredFile(file) {
  fs.chmodSync(file, 0o644);
  fs.rmSync(file);
}

/** Runs fn(client) in a transaction with the user triggers on the table switched off. Needs the owner role. */
async function withTriggersOff(client, table, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    const result = await fn(client);
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Picks an entry worth tampering with: the latest custody acceptance or registration. */
async function defaultTargetSeq(client) {
  const { rows } = await client.query(
    `SELECT seq FROM audit_log
      WHERE action IN ('CUSTODY_TRANSFER_ACCEPTED', 'EVIDENCE_REGISTERED')
      ORDER BY (action = 'CUSTODY_TRANSFER_ACCEPTED') DESC, seq DESC LIMIT 1`,
  );
  if (rows[0]) return rows[0].seq;
  const max = (await client.query('SELECT max(seq) AS m FROM audit_log')).rows[0].m;
  if (!max) throw new Error('the audit log is empty');
  return Math.max(1, Math.floor(max / 2));
}

/** Backdates one entry by an hour, leaving its stored hash alone. */
async function backdateEntry(client, seq) {
  return withTriggersOff(client, 'audit_log', async (c) => {
    const { rows } = await c.query(
      `UPDATE audit_log SET ts = ts - interval '1 hour' WHERE seq = $1
       RETURNING seq, action, ts`,
      [seq],
    );
    if (!rows[0]) throw new Error(`no audit entry #${seq}`);
    return rows[0];
  });
}

/**
 * Backdates one entry, then recomputes its hash and every later hash with
 * plain SHA-256, re-linking the chain. This is the best an attacker without
 * the HMAC key can do; the check still fails because the hashes are not HMACs.
 */
async function backdateAndRecompute(client, seq) {
  return withTriggersOff(client, 'audit_log', async (c) => {
    const edited = await c.query(`UPDATE audit_log SET ts = ts - interval '1 hour' WHERE seq = $1 RETURNING seq`, [seq]);
    if (!edited.rows[0]) throw new Error(`no audit entry #${seq}`);
    const before = await c.query('SELECT entry_hash FROM audit_log WHERE seq < $1 ORDER BY seq DESC LIMIT 1', [seq]);
    let prevHash = before.rows[0]?.entry_hash ?? '0'.repeat(64);
    const { rows } = await c.query('SELECT * FROM audit_log WHERE seq >= $1 ORDER BY seq', [seq]);
    for (const row of rows) {
      const text = canonicalEntry({
        prevHash,
        ts: row.ts,
        userId: row.user_id,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        details: row.details,
        ip: row.ip,
      });
      const entryHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      await c.query('UPDATE audit_log SET prev_hash = $1, entry_hash = $2 WHERE seq = $3', [prevHash, entryHash, row.seq]);
      prevHash = entryHash;
    }
    return { fromSeq: seq, recomputed: rows.length };
  });
}

/** Deletes the newest n entries. */
async function deleteNewest(client, n) {
  return withTriggersOff(client, 'audit_log', async (c) => {
    const { rows } = await c.query(
      `DELETE FROM audit_log WHERE seq IN (SELECT seq FROM audit_log ORDER BY seq DESC LIMIT $1)
       RETURNING seq, action`,
      [n],
    );
    return rows.sort((a, b) => a.seq - b.seq);
  });
}

module.exports = {
  flipStoredByte,
  deleteStoredFile,
  withTriggersOff,
  defaultTargetSeq,
  backdateEntry,
  backdateAndRecompute,
  deleteNewest,
};
