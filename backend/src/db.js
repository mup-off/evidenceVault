'use strict';

const { Pool, types } = require('pg');

const config = require('./config');

// BIGINT ids fit comfortably in a JavaScript number for this prototype.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

/** Runs fn(client) inside a transaction; commits on success, rolls back on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
