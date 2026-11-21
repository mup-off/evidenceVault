'use strict';

// SHA-256 hashing and AES-256-GCM encryption for evidence files.

const crypto = require('node:crypto');

const { getSecrets } = require('../secrets');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Encrypts with the current key. Returns { keyId, iv, authTag, ciphertext }. */
function encrypt(plaintext) {
  const { currentKeyId, keys } = getSecrets().encryption;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys[currentKeyId], iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { keyId: currentKeyId, iv, authTag: cipher.getAuthTag(), ciphertext };
}

class KeyUnavailableError extends Error {}

/**
 * Decrypts and authenticates. Throws KeyUnavailableError if the key is not in
 * secrets.json, or an Error if the ciphertext or tag was changed.
 */
function decrypt({ keyId, iv, authTag, ciphertext }) {
  const key = getSecrets().encryption.keys[keyId];
  if (!key) throw new KeyUnavailableError(`encryption key ${keyId} is not in the secrets file`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { sha256, encrypt, decrypt, KeyUnavailableError };
