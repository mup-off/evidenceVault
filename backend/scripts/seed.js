'use strict';

// Creates one demo account per role. Safe to run more than once: existing
// accounts are left unchanged.

const bcrypt = require('bcryptjs');

const config = require('../src/config');
const { pool, withTransaction } = require('../src/db');
const audit = require('../src/services/audit');

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'EvidenceVault#2026';

const DEMO_USERS = [
  { fullName: 'Demo Administrator', email: 'admin@evidencevault.local', role: 'administrator' },
  { fullName: 'Demo Investigator', email: 'investigator@evidencevault.local', role: 'investigator' },
  { fullName: 'Second Investigator', email: 'investigator2@evidencevault.local', role: 'investigator' },
  { fullName: 'Demo Custodian', email: 'custodian@evidencevault.local', role: 'custodian' },
  { fullName: 'Demo Auditor', email: 'auditor@evidencevault.local', role: 'auditor' },
];

async function main() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, config.bcryptRounds);
  for (const u of DEMO_USERS) {
    const created = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO users (full_name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [u.fullName, u.email, hash, u.role],
      );
      if (!rows[0]) return false;
      await audit.append(
        { action: 'USER_SEEDED', entity: 'user', entityId: rows[0].id, details: { email: u.email, role: u.role } },
        tx,
      );
      return true;
    });
    console.log(`${created ? 'created' : 'exists '}  ${u.role.padEnd(13)} ${u.email}`);
  }
  console.log(`\nDemo password for new accounts: ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
