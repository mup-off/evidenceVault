'use strict';

// Loads data/secrets.json: the JWT signing secret, the audit-log HMAC key and
// the file-encryption keys. The server never creates this file on its own;
// it is made once with `npm run keygen` and must be backed up separately.

const crypto = require('node:crypto');
const fs = require('node:fs');

const config = require('./config');

class SecretsMissingError extends Error {}

function randomKey() {
  return crypto.randomBytes(32).toString('base64');
}

function generateSecrets() {
  const keyId = `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    jwtSecret: randomKey(),
    auditHmacKey: randomKey(),
    encryption: {
      currentKeyId: keyId,
      keys: { [keyId]: randomKey() },
    },
  };
}

function decodeKey(value, label) {
  const buf = Buffer.from(String(value || ''), 'base64');
  if (buf.length !== 32) throw new Error(`${label} in secrets file must be 32 bytes, base64-encoded`);
  return buf;
}

function parseSecrets(raw) {
  const data = JSON.parse(raw);
  const keys = {};
  for (const [id, value] of Object.entries(data.encryption?.keys || {})) {
    keys[id] = decodeKey(value, `encryption key ${id}`);
  }
  const currentKeyId = data.encryption?.currentKeyId;
  if (!currentKeyId || !keys[currentKeyId]) {
    throw new Error('secrets file has no valid current encryption key');
  }
  return Object.freeze({
    jwtSecret: decodeKey(data.jwtSecret, 'jwtSecret'),
    auditHmacKey: decodeKey(data.auditHmacKey, 'auditHmacKey'),
    encryption: Object.freeze({ currentKeyId, keys: Object.freeze(keys) }),
  });
}

let cached = null;

function getSecrets() {
  if (cached) return cached;
  let raw;
  try {
    raw = fs.readFileSync(config.secretsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new SecretsMissingError(
        `Secrets file not found at ${config.secretsPath}. ` +
          'On a new install run `npm run keygen`. If evidence already exists, restore the file from backup: ' +
          'a new key cannot decrypt existing evidence.',
      );
    }
    throw err;
  }
  cached = parseSecrets(raw);
  return cached;
}

module.exports = { getSecrets, generateSecrets, SecretsMissingError };
