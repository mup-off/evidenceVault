'use strict';

// Loading evidence rows and shaping them for the browser. Shared by the
// evidence, custody and report routes.

const { pool } = require('../db');
const { HttpError } = require('../errors');
const { denyAccess } = require('./access');
const cases = require('./cases');

const SELECT_EVIDENCE = `
  SELECT e.*, c.case_number, c.status AS case_status,
         r.full_name AS registered_by_name, k.full_name AS custodian_name, k.role AS custodian_role
    FROM evidence e
    JOIN cases c ON c.id = e.case_id
    JOIN users r ON r.id = e.registered_by
    JOIN users k ON k.id = e.current_custodian_id`;

/** What the browser may see. Never storage_name, key_id, iv or auth_tag. */
function publicEvidence(row) {
  return {
    id: row.id,
    evidenceCode: row.evidence_code,
    caseId: row.case_id,
    caseNumber: row.case_number ?? undefined,
    caseStatus: row.case_status ?? undefined,
    title: row.title,
    description: row.description,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storedFileSha256: row.ciphertext_sha256,
    collectionMetadata: row.collection_metadata,
    registeredBy: row.registered_by,
    registeredByName: row.registered_by_name ?? undefined,
    currentCustodianId: row.current_custodian_id,
    currentCustodianName: row.custodian_name ?? undefined,
    integrityStatus: row.integrity_status,
    lastVerifiedAt: row.last_verified_at ? row.last_verified_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function findEvidence(evidenceId, client = pool) {
  const { rows } = await client.query(`${SELECT_EVIDENCE} WHERE e.id = $1`, [evidenceId]);
  return rows[0] || null;
}

/** Loads an item the user may view (via its case), or throws 404 / logged 403. */
async function getViewableEvidence(req, evidenceId) {
  const evidence = await findEvidence(evidenceId);
  if (!evidence) throw new HttpError(404, 'Evidence not found');
  const caseRow = await cases.findCase(evidence.case_id);
  if (!(await cases.canView(req.user, caseRow))) {
    throw await denyAccess(req, `not assigned to case ${caseRow.case_number} (evidence ${evidence.evidence_code})`, {
      entity: 'evidence',
      entityId: evidence.id,
    });
  }
  return evidence;
}

/** Every audit entry about one item, oldest first, with the acting user's name. */
async function history(evidenceId) {
  const { rows } = await pool.query(
    `SELECT a.*, u.full_name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity = 'evidence' AND a.entity_id = $1
      ORDER BY a.seq`,
    [String(evidenceId)],
  );
  return rows;
}

module.exports = { SELECT_EVIDENCE, publicEvidence, findEvidence, getViewableEvidence, history };
