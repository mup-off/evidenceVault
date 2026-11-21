'use strict';

// Encrypted evidence files on disk. Files are written once, read-only, under
// random names; nothing about the evidence can be learned from the file name.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const config = require('../config');

function pathFor(storageName) {
  if (!/^[0-9a-f-]{36}\.enc$/.test(storageName)) throw new Error('invalid storage name');
  return path.join(config.evidenceDir, storageName);
}

/** Writes a new read-only file and returns its storage name. Never overwrites. */
async function write(ciphertext) {
  await fs.mkdir(config.evidenceDir, { recursive: true });
  const storageName = `${crypto.randomUUID()}.enc`;
  const file = pathFor(storageName);
  await fs.writeFile(file, ciphertext, { flag: 'wx', mode: 0o444 });
  await fs.chmod(file, 0o444); // the mode above is masked by umask on some systems
  return storageName;
}

/** Returns the file contents, or null if the file is missing. */
async function read(storageName) {
  try {
    return await fs.readFile(pathFor(storageName));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Only used to clean up after a failed registration. */
async function remove(storageName) {
  const file = pathFor(storageName);
  await fs.chmod(file, 0o644).catch(() => {});
  await fs.rm(file, { force: true });
}

module.exports = { write, read, remove, pathFor };
