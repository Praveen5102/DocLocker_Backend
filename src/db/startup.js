// Railway storage readiness. New students are stored on Railway (Postgres +
// encrypted bucket) only when the database, bucket and encryption key are
// ALL configured; with any one missing everything keeps using Google Drive.

const { isDbEnabled } = require('./index');
const { runMigrations } = require('./migrate');
const { isBucketEnabled } = require('../services/objectStore');
const { isEncryptionConfigured } = require('../services/dataCrypto');
const { scheduleBackups } = require('../services/backup');

let ready = false;

function isRailwayStorageReady() {
  return ready;
}

// scheduled: only the running server schedules nightly backups — scripts
// and tests that also call this must not.
async function runDriveImports() {
  // Accounts live in Postgres; the first boot copies the old Drive roster in.
  const accounts = require('../services/accounts');
  await accounts.importLegacyAccounts()
    .then(() => accounts.backfillEmailsFromNames())
    .catch((err) => console.error('[accounts] import from admins.json failed:', err.message));
  // The small Drive JSON files (audit log, lender access requests) are copied
  // in once; student folders move with scripts/migrate-drive-to-railway.js.
  const driveImport = require('../services/driveImport');
  await driveImport.importLegacyAuditLog()
    .then(() => driveImport.importLegacyRequests())
    .catch((err) => console.error('[import] copying Drive JSON files failed:', err.message));
}

// imports: false skips the one-time Drive copies (the migration script's dry run).
async function initRailwayStorage({ schedule = false, imports = true } = {}) {
  const parts = { database: isDbEnabled(), bucket: isBucketEnabled(), encryption: isEncryptionConfigured() };
  if (!parts.database) {
    console.log('[storage] Railway storage off (no DATABASE_URL) — using Google Drive');
    return false;
  }
  await runMigrations();
  if (imports) await runDriveImports();
  ready = parts.bucket && parts.encryption;
  console.log(ready
    ? '[storage] Railway storage ready (Postgres + encrypted bucket)'
    : `[storage] Railway storage incomplete (bucket: ${parts.bucket}, encryption key: ${parts.encryption}) — using Google Drive`);
  if (ready && schedule) scheduleBackups();
  return ready;
}

module.exports = { initRailwayStorage, isRailwayStorageReady };
