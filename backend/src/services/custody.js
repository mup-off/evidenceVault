'use strict';

// Custody transfers. The holder (or an administrator) requests a transfer,
// and the recipient accepts or rejects it. The custodian changes only on
// acceptance, inside a transaction that locks the transfer and the evidence
// row and re-checks who holds the item.
//
// Rules (see "Roles and permissions" in the plan):
// - investigators and custodians may request transfers of items they hold;
// - administrators may request a transfer of any item; when they do not hold
//   it, this is a reassignment and is logged as CUSTODY_REASSIGNED;
// - every transfer needs a reason;
// - recipients must be active administrators, investigators or custodians;
//   an investigator recipient must be assigned to the item's case;
// - closed cases refuse new requests and acceptances (rejecting or cancelling
//   a pending transfer is still allowed);
// - only the recipient may accept or reject; the requester, the holder or an
//   administrator may cancel.

const { pool, withTransaction } = require('../db');
const { HttpError } = require('../errors');
const { denyAccess } = require('./access');
const audit = require('./audit');
const cases = require('./cases');

const HOLDER_ROLES = new Set(['administrator', 'investigator', 'custodian']);

const SELECT_TRANSFER = `
  SELECT t.*, e.evidence_code, e.case_id, c.case_number,
         f.full_name AS from_name, f.role AS from_role,
         o.full_name AS to_name,   o.role AS to_role,
         q.full_name AS requested_by_name,
         d.full_name AS decided_by_name
    FROM custody_transfers t
    JOIN evidence e ON e.id = t.evidence_id
    JOIN cases c    ON c.id = e.case_id
    JOIN users f    ON f.id = t.from_user_id
    JOIN users o    ON o.id = t.to_user_id
    JOIN users q    ON q.id = t.requested_by
    LEFT JOIN users d ON d.id = t.decided_by`;

function publicTransfer(row) {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    evidenceCode: row.evidence_code,
    caseId: row.case_id,
    caseNumber: row.case_number,
    from: { id: row.from_user_id, fullName: row.from_name, role: row.from_role },
    to: { id: row.to_user_id, fullName: row.to_name, role: row.to_role },
    requestedBy: { id: row.requested_by, fullName: row.requested_by_name },
    reassignment: row.requested_by !== row.from_user_id,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    decidedBy: row.decided_by ? { id: row.decided_by, fullName: row.decided_by_name } : null,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decisionNote: row.decision_note,
  };
}

async function findTransfer(transferId, client = pool) {
  const { rows } = await client.query(`${SELECT_TRANSFER} WHERE t.id = $1`, [transferId]);
  return rows[0] || null;
}

async function listForEvidence(evidenceId) {
  const { rows } = await pool.query(`${SELECT_TRANSFER} WHERE t.evidence_id = $1 ORDER BY t.requested_at, t.id`, [
    evidenceId,
  ]);
  return rows.map(publicTransfer);
}

/**
 * Transfers visible in the user's own lists.
 * direction: 'incoming' (to me) | 'outgoing' (from me or requested by me) |
 *            'mine' (either) | 'all' (administrators and auditors only).
 */
async function list(user, { status = null, direction = 'mine', limit = 200 } = {}) {
  const { rows } = await pool.query(
    `${SELECT_TRANSFER}
      WHERE ($1::text IS NULL OR t.status = $1)
        AND CASE $2
              WHEN 'incoming' THEN t.to_user_id = $3
              WHEN 'outgoing' THEN (t.from_user_id = $3 OR t.requested_by = $3)
              WHEN 'all'      THEN TRUE
              ELSE (t.to_user_id = $3 OR t.from_user_id = $3 OR t.requested_by = $3)
            END
      ORDER BY t.requested_at DESC, t.id DESC
      LIMIT $4`,
    [status, direction, user.id, limit],
  );
  return rows.map(publicTransfer);
}

/** Checks that a user may receive this item. Returns the user row or throws 400/404. */
async function checkRecipient(toUserId, evidence, client = pool) {
  const { rows } = await client.query('SELECT id, full_name, role, active FROM users WHERE id = $1', [toUserId]);
  const recipient = rows[0];
  if (!recipient) throw new HttpError(404, 'Recipient not found');
  if (!recipient.active) throw new HttpError(400, 'The recipient account is not active');
  if (!HOLDER_ROLES.has(recipient.role)) {
    throw new HttpError(400, `A ${recipient.role} cannot hold evidence; choose an administrator, investigator or custodian`);
  }
  if (recipient.role === 'investigator' && !(await cases.isMember(evidence.case_id, recipient.id, client))) {
    throw new HttpError(400, `${recipient.full_name} is not assigned to case ${evidence.case_number}`);
  }
  return recipient;
}

/** Creates a pending transfer. evidence is a row the user may already view. */
async function request(req, evidence, { toUserId, reason }) {
  const isHolder = evidence.current_custodian_id === req.user.id;
  if (!isHolder && req.user.role !== 'administrator') {
    throw await denyAccess(req, `does not hold evidence ${evidence.evidence_code}`, {
      entity: 'evidence',
      entityId: evidence.id,
    });
  }
  if (evidence.case_status === 'closed') {
    throw new HttpError(409, `Case ${evidence.case_number} is closed; custody cannot be transferred`);
  }
  if (toUserId === evidence.current_custodian_id) {
    throw new HttpError(400, 'That user already holds this item');
  }
  const recipient = await checkRecipient(toUserId, evidence);

  let transferId;
  try {
    transferId = await withTransaction(async (tx) => {
      // Lock the item and re-check the holder, so the request names the real current custodian.
      const locked = await tx.query(
        `SELECT e.current_custodian_id, c.status AS case_status
           FROM evidence e JOIN cases c ON c.id = e.case_id
          WHERE e.id = $1 FOR UPDATE OF e`,
        [evidence.id],
      );
      const holderId = locked.rows[0].current_custodian_id;
      if (holderId !== evidence.current_custodian_id) {
        throw new HttpError(409, 'Custody of this item changed while you were working; reload and try again');
      }
      if (locked.rows[0].case_status === 'closed') {
        throw new HttpError(409, `Case ${evidence.case_number} is closed; custody cannot be transferred`);
      }

      const { rows } = await tx.query(
        `INSERT INTO custody_transfers (evidence_id, from_user_id, to_user_id, requested_by, reason)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [evidence.id, holderId, recipient.id, req.user.id, reason],
      );
      await audit.append(
        {
          ...audit.fromRequest(req),
          action: isHolder ? 'CUSTODY_TRANSFER_REQUESTED' : 'CUSTODY_REASSIGNED',
          entity: 'evidence',
          entityId: evidence.id,
          details: {
            transferId: rows[0].id,
            evidenceCode: evidence.evidence_code,
            fromUserId: holderId,
            toUserId: recipient.id,
            toName: recipient.full_name,
            reason,
          },
        },
        tx,
      );
      return rows[0].id;
    });
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'custody_transfers_one_pending_idx') {
      throw new HttpError(409, `Evidence ${evidence.evidence_code} already has a pending transfer`);
    }
    throw err;
  }
  return publicTransfer(await findTransfer(transferId));
}

const DECISIONS = {
  accept: { status: 'accepted', action: 'CUSTODY_TRANSFER_ACCEPTED' },
  reject: { status: 'rejected', action: 'CUSTODY_TRANSFER_REJECTED' },
  cancel: { status: 'cancelled', action: 'CUSTODY_TRANSFER_CANCELLED' },
};

function mayDecide(user, transfer, decision) {
  if (decision === 'cancel') {
    return user.role === 'administrator' || user.id === transfer.requested_by || user.id === transfer.from_user_id;
  }
  return user.id === transfer.to_user_id;
}

/** Accepts, rejects or cancels a pending transfer. decision: 'accept' | 'reject' | 'cancel'. */
async function decide(req, transferId, decision, note = null) {
  const { status, action } = DECISIONS[decision];
  const transfer = await findTransfer(transferId);
  if (!transfer) throw new HttpError(404, 'Transfer not found');
  if (!mayDecide(req.user, transfer, decision)) {
    throw await denyAccess(req, `may not ${decision} custody transfer ${transfer.id} (${transfer.evidence_code})`, {
      entity: 'evidence',
      entityId: transfer.evidence_id,
    });
  }

  await withTransaction(async (tx) => {
    // Lock the transfer first: of two simultaneous decisions, the second one
    // waits here and then sees that the transfer is no longer pending.
    const t = (await tx.query('SELECT * FROM custody_transfers WHERE id = $1 FOR UPDATE', [transferId])).rows[0];
    if (t.status !== 'pending') throw new HttpError(409, `This transfer was already ${t.status}`);

    const ev = (
      await tx.query(
        `SELECT e.current_custodian_id, c.status AS case_status
           FROM evidence e JOIN cases c ON c.id = e.case_id
          WHERE e.id = $1 FOR UPDATE OF e`,
        [t.evidence_id],
      )
    ).rows[0];

    if (decision === 'accept') {
      if (ev.case_status === 'closed') {
        throw new HttpError(409, `Case ${transfer.case_number} is closed; custody cannot be transferred`);
      }
      if (ev.current_custodian_id !== t.from_user_id) {
        throw new HttpError(409, 'The item is no longer held by the person who requested this transfer');
      }
      // Re-check the recipient: an investigator may have been removed from the case since.
      await checkRecipient(t.to_user_id, { case_id: transfer.case_id, case_number: transfer.case_number }, tx);
      await tx.query('UPDATE evidence SET current_custodian_id = $1 WHERE id = $2', [t.to_user_id, t.evidence_id]);
    }

    await tx.query(
      `UPDATE custody_transfers
          SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $4`,
      [status, req.user.id, note, transferId],
    );
    await audit.append(
      {
        ...audit.fromRequest(req),
        action,
        entity: 'evidence',
        entityId: t.evidence_id,
        details: {
          transferId: t.id,
          evidenceCode: transfer.evidence_code,
          fromUserId: t.from_user_id,
          toUserId: t.to_user_id,
          reason: t.reason,
          note: note || undefined,
        },
      },
      tx,
    );
  });

  return publicTransfer(await findTransfer(transferId));
}

module.exports = { publicTransfer, findTransfer, listForEvidence, list, request, decide };
