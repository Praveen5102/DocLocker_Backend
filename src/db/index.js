// Postgres connection for Railway-stored data. Dormant unless DATABASE_URL is
// set, so this code can ship before the production service is configured —
// every caller checks isDbEnabled() first and the Drive path keeps working.
//
// On Railway the URL points at the project's private Postgres service
// (*.railway.internal), which has no public address at all. Locally it
// points at the embedded dev server from scripts/dev-db.mjs.

const { Pool } = require('pg');

let pool = null;

function isDbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

// Private-network and local connections don't use TLS; anything else does.
function sslFor(url) {
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!isDbEnabled()) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslFor(process.env.DATABASE_URL),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

// Always parameterized — never interpolate values into `text`.
function query(text, params = []) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
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

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { isDbEnabled, getPool, query, withTransaction, closeDb };
