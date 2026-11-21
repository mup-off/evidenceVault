'use strict';

// Creates data/secrets.json once. Never overwrites an existing file: replacing
// the encryption key would make every stored evidence file unreadable.

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const { generateSecrets } = require('../src/secrets');

const target = config.secretsPath;

if (fs.existsSync(target)) {
  console.error(`Refusing to overwrite ${target}.`);
  console.error('It already holds the keys for this installation. Delete it only if you are sure no evidence depends on it.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(generateSecrets(), null, 2)}\n`, { flag: 'wx', mode: 0o600 });

console.log(`Created ${target}`);
console.log('Back this file up now, somewhere separate from the database and the evidence files.');
console.log('Without it, stored evidence cannot be decrypted and the audit log cannot be verified.');
