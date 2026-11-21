'use strict';

/** The fields of a user row that may leave the API. Never includes the password hash. */
function publicUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    active: row.active,
    lockedUntil: row.locked_until && row.locked_until > new Date() ? row.locked_until.toISOString() : null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

module.exports = { publicUser };
