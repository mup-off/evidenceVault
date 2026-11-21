'use strict';

// DEMO ONLY. Simulates someone with server access altering a stored evidence file.
//
//   npm run tamper:file -- EV-2026-000001            flip one bit in the stored file
//   npm run tamper:file -- EV-2026-000001 --delete   delete the stored file
//
// Then run Verify integrity (or try to download) and watch it fail.

const path = require('node:path');
const { Client } = require('pg');

const config = require('../../src/config');
const { flipStoredByte, deleteStoredFile } = require('./lib');

async function main() {
  if (config.env === 'production') throw new Error('tamper scripts are for demos only and refuse to run in production');
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const remove = args.includes('--delete');
  if (!target) {
    console.error('Usage: npm run tamper:file -- <evidence code or id> [--delete]');
    process.exitCode = 1;
    return;
  }
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is not set in .env');

  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, evidence_code, storage_name FROM evidence WHERE evidence_code = $1 OR id::text = $1',
      [target.toUpperCase()],
    );
    if (!rows[0]) throw new Error(`no evidence ${target}`);
    const file = path.join(config.evidenceDir, rows[0].storage_name);

    if (remove) {
      deleteStoredFile(file);
      console.log(`Deleted the stored file for ${rows[0].evidence_code}: ${file}`);
    } else {
      const r = flipStoredByte(file);
      console.log(`Flipped one bit at byte ${r.offset} of the stored file for ${rows[0].evidence_code}.`);
      console.log(`  SHA-256 before: ${r.before}`);
      console.log(`  SHA-256 after:  ${r.after}`);
    }
    console.log('Now run Verify integrity on the item; it should report Failed and block downloads.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`tamper:file failed: ${err.message}`);
  process.exitCode = 1;
});
