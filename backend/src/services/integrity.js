'use strict';

// Integrity checks. A check passes only if all of these hold:
//   1. the stored file exists;
//   2. its SHA-256 matches the hash recorded at intake (ciphertext_sha256);
//   3. it decrypts and authenticates with AES-256-GCM;
//   4. the decrypted file's SHA-256 matches the original hash (sha256).
// Every check is written to the audit log; a failure raises a critical alert.

const { pool, withTransaction } = require('../db');
const alerts = require('./alerts');
const audit = require('./audit');
const store = require('./evidenceStore');
const { sha256, decrypt, KeyUnavailableError } = require('./fileCrypto');

const REASON_TEXT = {
  FILE_MISSING: 'the stored file is missing',
  STORED_FILE_CHANGED: 'the stored file no longer matches its recorded hash',
  DECRYPTION_AUTH_FAILED: 'decryption authentication failed (the encrypted file was altered)',
  KEY_UNAVAILABLE: 'the encryption key for this item is not available',
  ORIGINAL_HASH_MISMATCH: 'the decrypted file does not match the original hash',
};

/** Runs the check without recording anything. Returns { result, plaintext }. */
async function inspect(evidence) {
  const result = {
    status: 'verified',
    reasons: [],
    recorded: { sha256: evidence.sha256, storedFileSha256: evidence.ciphertext_sha256 },
    current: { sha256: null, storedFileSha256: null },
    checkedAt: new Date().toISOString(),
  };
  const fail = (code) => {
    result.status = 'failed';
    result.reasons.push(code);
  };

  const ciphertext = await store.read(evidence.storage_name);
  if (!ciphertext) {
    fail('FILE_MISSING');
    return { result, plaintext: null };
  }

  result.current.storedFileSha256 = sha256(ciphertext);
  if (result.current.storedFileSha256 !== evidence.ciphertext_sha256) fail('STORED_FILE_CHANGED');

  let plaintext = null;
  try {
    plaintext = decrypt({ keyId: evidence.key_id, iv: evidence.iv, authTag: evidence.auth_tag, ciphertext });
  } catch (err) {
    fail(err instanceof KeyUnavailableError ? 'KEY_UNAVAILABLE' : 'DECRYPTION_AUTH_FAILED');
    return { result, plaintext: null };
  }

  result.current.sha256 = sha256(plaintext);
  if (result.current.sha256 !== evidence.sha256) fail('ORIGINAL_HASH_MISMATCH');

  return { result, plaintext: result.status === 'verified' ? plaintext : null };
}

function summarize(result) {
  return result.reasons.map((r) => REASON_TEXT[r] || r).join('; ');
}

/**
 * Checks one item and records the outcome (status, audit entry, alert on
 * failure). trigger: 'manual' | 'download' | 'report'.
 * Returns { result, plaintext } — plaintext only when the check passed.
 */
async function verifyAndRecord(evidence, { req, trigger }) {
  const { result, plaintext } = await inspect(evidence);
  const failed = result.status === 'failed';

  await withTransaction(async (tx) => {
    await tx.query('UPDATE evidence SET integrity_status = $1, last_verified_at = $2 WHERE id = $3', [
      result.status,
      result.checkedAt,
      evidence.id,
    ]);
    await audit.append(
      {
        ...audit.fromRequest(req),
        action: failed ? 'INTEGRITY_FAILED' : 'INTEGRITY_VERIFIED',
        entity: 'evidence',
        entityId: evidence.id,
        details: { evidenceCode: evidence.evidence_code, trigger, reasons: result.reasons, recorded: result.recorded, current: result.current },
      },
      tx,
    );
    if (failed) {
      await alerts.raise(
        {
          severity: 'critical',
          type: 'INTEGRITY_FAILED',
          message: `Integrity check failed for ${evidence.evidence_code}: ${summarize(result)}`,
          evidenceId: evidence.id,
          userId: req.user?.id ?? null,
        },
        tx,
      );
    }
  });

  return { result: { ...result, summary: failed ? summarize(result) : 'All hashes match' }, plaintext };
}

/** Loads the full evidence row (including storage fields) for internal use. */
async function loadForCheck(evidenceId) {
  const { rows } = await pool.query('SELECT * FROM evidence WHERE id = $1', [evidenceId]);
  return rows[0] || null;
}

module.exports = { inspect, verifyAndRecord, loadForCheck };
