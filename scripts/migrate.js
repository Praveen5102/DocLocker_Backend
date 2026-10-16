// npm run db:migrate — apply pending migrations to DATABASE_URL.
require('dotenv').config();
const { runMigrations } = require('../src/db/migrate');
const { closeDb, isDbEnabled } = require('../src/db');

(async () => {
  if (!isDbEnabled()) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  try {
    await runMigrations();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
})();
