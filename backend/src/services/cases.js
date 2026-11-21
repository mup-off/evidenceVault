'use strict';

// Case-level access rules (see "Roles and permissions" in the plan):
// - administrators, custodians and auditors may view every case;
// - investigators may view only cases they are members of;
// - administrators may manage any case; investigators only cases they created.

const { pool } = require('../db');
const { HttpError } = require('../errors');
const { denyAccess } = require('./access');

const VIEW_ALL_ROLES = new Set(['administrator', 'custodian', 'auditor']);

async function findCase(caseId, client = pool) {
  const { rows } = await client.query('SELECT * FROM cases WHERE id = $1', [caseId]);
  return rows[0] || null;
}

async function isMember(caseId, userId, client = pool) {
  const { rowCount } = await client.query('SELECT 1 FROM case_members WHERE case_id = $1 AND user_id = $2', [
    caseId,
    userId,
  ]);
  return rowCount > 0;
}

async function canView(user, caseRow) {
  if (VIEW_ALL_ROLES.has(user.role)) return true;
  if (user.role === 'investigator') return isMember(caseRow.id, user.id);
  return false;
}

function canManage(user, caseRow) {
  if (user.role === 'administrator') return true;
  return user.role === 'investigator' && caseRow.created_by === user.id;
}

/** Loads a case the user may view, or throws 404 / 403 (403 is logged). */
async function getViewableCase(req, caseId) {
  const caseRow = await findCase(caseId);
  if (!caseRow) throw new HttpError(404, 'Case not found');
  if (!(await canView(req.user, caseRow))) {
    throw await denyAccess(req, `not assigned to case ${caseRow.case_number}`, { entity: 'case', entityId: caseRow.id });
  }
  return caseRow;
}

/** Loads a case the user may manage, or throws 404 / 403 (403 is logged). */
async function getManageableCase(req, caseId) {
  const caseRow = await getViewableCase(req, caseId);
  if (!canManage(req.user, caseRow)) {
    throw await denyAccess(req, `may not manage case ${caseRow.case_number}`, { entity: 'case', entityId: caseRow.id });
  }
  return caseRow;
}

module.exports = { findCase, isMember, canView, canManage, getViewableCase, getManageableCase };
