// Applies src/db/migrations/*.sql in filename order, each in its own
// transaction, recording what ran in schema_migrations. An advisory lock
// stops two backend instances from migrating at the same time.
// Migrations are append-only: never edit one that has shipped — add a new file.

const fs = require('fs');
const path = require('path');
const { getPool } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 727301; // arbitrary, fixed

async function runMigrations({ log = console.log } = {}) {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const ran = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran.push(file);
        log(`[db] applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    if (!ran.length) log('[db] schema up to date');
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations };
