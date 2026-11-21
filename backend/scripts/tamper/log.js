'use strict';

// DEMO ONLY. Simulates someone with database access editing the audit log.
// Connects as the owner role and switches off the append-only triggers.
//
//   npm run tamper:log                        backdate one entry by an hour (picks a custody or intake entry)
//   npm run tamper:log -- --seq 42            backdate entry #42
//   npm run tamper:log -- --recompute         backdate, then recompute later hashes with plain SHA-256
//   npm run tamper:log -- --delete-newest 3   delete the newest 3 entries
//
// Then click Verify chain (POST /api/audit/verify) and see where it breaks.
// Deleting the newest entries is detected only once a report or a successful
// chain check has anchored a head that is now gone.

const { Client } = require('pg');

const config = require('../../src/config');
const tamper = require('./lib');
const { pool } = require('../../src/db');

function option(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} needs a positive whole number`);
  return value;
}

async function main() {
  if (config.env === 'production') throw new Error('tamper scripts are for demos only and refuse to run in production');
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is not set in .env');
  const args = process.argv.slice(2);

  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    const deleteCount = option(args, '--delete-newest');
    if (deleteCount) {
      const deleted = await tamper.deleteNewest(client, deleteCount);
      console.log(`Deleted ${deleted.length} newest entries: ${deleted.map((d) => `#${d.seq} ${d.action}`).join(', ')}`);
      return;
    }

    const seq = option(args, '--seq') ?? (await tamper.defaultTargetSeq(client));
    if (args.includes('--recompute')) {
      const r = await tamper.backdateAndRecompute(client, seq);
      console.log(`Backdated entry #${seq} by one hour and recomputed ${r.recomputed} hashes with plain SHA-256.`);
      console.log('The links look consistent, but the hashes are not HMACs, so the check still fails.');
    } else {
      const r = await tamper.backdateEntry(client, seq);
      console.log(`Backdated entry #${r.seq} (${r.action}) by one hour, to ${r.ts.toISOString()}.`);
    }
  } finally {
    await client.end();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`tamper:log failed: ${err.message}`);
  process.exitCode = 1;
});
