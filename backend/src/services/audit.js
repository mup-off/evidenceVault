'use strict';

// Append-only, HMAC-chained audit log.
//
// Each entry's hash is HMAC-SHA256(auditHmacKey, canonical(entry)), where the
// canonical form includes the previous entry's hash. Without the key, nobody
// can recompute the chain after editing the database.
//
// Database triggers reject UPDATE, DELETE and TRUNCATE on audit_log. Reports
// and successful chain checks record the chain head in audit_anchors (also
// HMAC-signed), so deleting the newest entries is detected as well.

const crypto = require('node:crypto');

const { pool, withTransaction } = require('../db');
const { getSecrets } = require('../secrets');

const GENESIS_HASH = '0'.repeat(64);
// Arbitrary constant: the key of the transaction-level advisory lock that
// serialises appends, so two writers can never link to the same previous entry.
const AUDIT_LOCK_KEY = 7_420_260_001;

/** JSON with object keys sorted at every level, so the same data always serialises the same way. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const asText = (v) => (v === null || v === undefined ? null : String(v));

/** The exact string that is hashed for one entry. ts must be a Date. */
function canonicalEntry({ prevHash, ts, userId, action, entity, entityId, details, ip }) {
  return canonicalJson([
    prevHash,
    ts.toISOString(),
    asText(userId),
    action,
    asText(entity),
    asText(entityId),
    canonicalJson(details || {}),
    asText(ip),
  ]);
}

function computeHash(fields) {
  return crypto.createHmac('sha256', getSecrets().auditHmacKey).update(canonicalEntry(fields), 'utf8').digest('hex');
}

async function appendWith(client, entry) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
  const last = await client.query('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const fields = {
    prevHash: last.rows[0]?.entry_hash ?? GENESIS_HASH,
    ts: new Date(), // millisecond precision; the column is TIMESTAMPTZ(3)
    userId: entry.userId ?? null,
    action: entry.action,
    entity: entry.entity ?? null,
    entityId: entry.entityId ?? null,
    // Round-trip through JSON so the hashed value is exactly what JSONB stores
    // (for example, a Date becomes its ISO string and undefined fields vanish).
    details: JSON.parse(JSON.stringify(entry.details || {})),
    ip: entry.ip ?? null,
  };
  const entryHash = computeHash(fields);
  const { rows } = await client.query(
    `INSERT INTO audit_log (ts, user_id, action, entity, entity_id, details, ip, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING seq`,
    [
      fields.ts,
      fields.userId,
      fields.action,
      asText(fields.entity),
      asText(fields.entityId),
      JSON.stringify(fields.details),
      asText(fields.ip),
      fields.prevHash,
      entryHash,
    ],
  );
  return { seq: rows[0].seq, entryHash };
}

/**
 * Appends one entry. Pass a transaction client to make the entry part of that
 * transaction; otherwise the entry is written in its own transaction.
 * entry: { action, userId?, entity?, entityId?, details?, ip? }
 */
async function append(entry, client) {
  if (client && client !== pool) return appendWith(client, entry);
  return withTransaction((tx) => appendWith(tx, entry));
}

/** Audit fields taken from the request: who and from where. */
function fromRequest(req) {
  return { userId: req.user?.id ?? null, ip: req.ip ?? null };
}

// ---------------------------------------------------------------------------
// Chain head and anchors
// ---------------------------------------------------------------------------

/** The latest entry: { seq, entryHash, ts } or null for an empty log. */
async function head(client = pool) {
  const { rows } = await client.query('SELECT seq, entry_hash, ts FROM audit_log ORDER BY seq DESC LIMIT 1');
  if (!rows[0]) return null;
  return { seq: rows[0].seq, entryHash: rows[0].entry_hash, ts: rows[0].ts.toISOString() };
}

function anchorHash({ anchoredAt, headSeq, headHash, reason }) {
  const text = canonicalJson(['anchor', anchoredAt.toISOString(), String(headSeq), headHash, reason]);
  return crypto.createHmac('sha256', getSecrets().auditHmacKey).update(text, 'utf8').digest('hex');
}

async function anchorWith(client, reason) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
  const current = await head(client);
  if (!current) throw new Error('cannot anchor an empty audit log');
  const anchoredAt = new Date();
  const hash = anchorHash({ anchoredAt, headSeq: current.seq, headHash: current.entryHash, reason });
  const { rows } = await client.query(
    `INSERT INTO audit_anchors (anchored_at, head_seq, head_hash, reason, anchor_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [anchoredAt, current.seq, current.entryHash, reason, hash],
  );
  return { anchorId: rows[0].id, seq: current.seq, entryHash: current.entryHash, anchoredAt: anchoredAt.toISOString() };
}

/**
 * Records the current chain head. Call it after appending the entry that
 * should be the head (in the same transaction when a client is given).
 * reason: 'report' | 'chain_verified'
 */
async function anchor(reason, client) {
  if (client && client !== pool) return anchorWith(client, reason);
  return withTransaction((tx) => anchorWith(tx, reason));
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

const BREAK_TEXT = {
  ENTRY_HASH_MISMATCH: 'the entry was changed after it was written',
  PREVIOUS_HASH_MISMATCH: 'the link to the previous entry is broken (an entry before it was changed or deleted)',
};
const ANCHOR_TEXT = {
  ANCHOR_SIGNATURE_INVALID: 'the anchor record itself was altered or forged',
  ANCHORED_ENTRY_CHANGED: 'the anchored entry no longer has the hash recorded in the anchor',
  ANCHORED_ENTRY_MISSING: 'the anchored entry no longer exists (entries were deleted)',
};
const MAX_LISTED_PROBLEMS = 50;

function fieldsFromRow(row) {
  return {
    prevHash: row.prev_hash,
    ts: row.ts,
    userId: row.user_id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    details: row.details,
    ip: row.ip,
  };
}

/**
 * Walks the whole log in one consistent snapshot and checks that
 *   1. every entry's HMAC matches its contents;
 *   2. every entry links to the hash of the entry before it;
 *   3. every anchor is genuine and its entry still exists with the same hash.
 * Records nothing; routes/audit.js logs the outcome.
 */
async function verifyChain({ batchSize = 1000 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const anchorRows = (await client.query('SELECT * FROM audit_anchors ORDER BY id')).rows;
    const anchorProblems = [];
    const anchorsBySeq = new Map();
    for (const a of anchorRows) {
      const expected = anchorHash({ anchoredAt: a.anchored_at, headSeq: a.head_seq, headHash: a.head_hash, reason: a.reason });
      if (expected !== a.anchor_hash) {
        anchorProblems.push({ anchorId: a.id, seq: a.head_seq, problem: 'ANCHOR_SIGNATURE_INVALID' });
        continue;
      }
      if (!anchorsBySeq.has(a.head_seq)) anchorsBySeq.set(a.head_seq, []);
      anchorsBySeq.get(a.head_seq).push(a);
    }

    const breaks = [];
    let brokenCount = 0;
    let entriesChecked = 0;
    let prevHash = GENESIS_HASH;
    let last = null;
    let afterSeq = 0;

    for (;;) {
      const { rows } = await client.query('SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT $2', [
        afterSeq,
        batchSize,
      ]);
      for (const row of rows) {
        let problem = null;
        if (row.prev_hash !== prevHash) problem = 'PREVIOUS_HASH_MISMATCH';
        else if (computeHash(fieldsFromRow(row)) !== row.entry_hash) problem = 'ENTRY_HASH_MISMATCH';
        if (problem) {
          brokenCount += 1;
          if (breaks.length < MAX_LISTED_PROBLEMS) {
            breaks.push({ seq: row.seq, action: row.action, ts: row.ts.toISOString(), problem, explanation: BREAK_TEXT[problem] });
          }
        }
        for (const a of anchorsBySeq.get(row.seq) || []) {
          if (a.head_hash !== row.entry_hash) {
            anchorProblems.push({ anchorId: a.id, seq: a.head_seq, problem: 'ANCHORED_ENTRY_CHANGED' });
          }
        }
        anchorsBySeq.delete(row.seq);
        prevHash = row.entry_hash;
        last = row;
        entriesChecked += 1;
      }
      if (rows.length < batchSize) break;
      afterSeq = rows[rows.length - 1].seq;
    }

    for (const list of anchorsBySeq.values()) {
      for (const a of list) anchorProblems.push({ anchorId: a.id, seq: a.head_seq, problem: 'ANCHORED_ENTRY_MISSING' });
    }
    anchorProblems.sort((x, y) => x.anchorId - y.anchorId);

    await client.query('COMMIT');

    const latest = anchorRows[anchorRows.length - 1];
    return {
      intact: brokenCount === 0 && anchorProblems.length === 0,
      checkedAt: new Date().toISOString(),
      entriesChecked,
      head: last ? { seq: last.seq, entryHash: last.entry_hash, ts: last.ts.toISOString() } : null,
      firstBreak: breaks[0] || null,
      brokenCount,
      breaks,
      anchors: {
        checked: anchorRows.length,
        latest: latest
          ? { anchorId: latest.id, seq: latest.head_seq, entryHash: latest.head_hash, anchoredAt: latest.anchored_at.toISOString() }
          : null,
        problemCount: anchorProblems.length,
        problems: anchorProblems.slice(0, MAX_LISTED_PROBLEMS).map((p) => ({ ...p, explanation: ANCHOR_TEXT[p.problem] })),
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One-line description of a broken chain, for alerts and responses. */
function describeProblems(result) {
  const parts = [];
  if (result.firstBreak) {
    const n = result.brokenCount;
    parts.push(`${n} ${n === 1 ? 'entry' : 'entries'} failed, first at #${result.firstBreak.seq} (${result.firstBreak.explanation})`);
  }
  if (result.anchors.problemCount > 0) {
    const first = result.anchors.problems[0];
    parts.push(`${result.anchors.problemCount} anchor problem(s), first at #${first.seq} (${first.explanation})`);
  }
  return parts.join('; ');
}

/** What the browser sees for one entry. userName comes from a join, if present. */
function publicEntry(row) {
  return {
    seq: row.seq,
    ts: row.ts.toISOString(),
    userId: row.user_id,
    userName: row.user_name ?? undefined,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    details: row.details,
    ip: row.ip,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
  };
}

module.exports = {
  append,
  fromRequest,
  head,
  anchor,
  verifyChain,
  describeProblems,
  publicEntry,
  canonicalJson,
  canonicalEntry,
  computeHash,
  GENESIS_HASH,
};
