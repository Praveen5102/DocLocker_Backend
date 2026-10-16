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
async function initRailwayStorage({ schedule = false } = {}) {
  const parts = { database: isDbEnabled(), bucket: isBucketEnabled(), encryption: isEncryptionConfigured() };
  if (!parts.database) {
    console.log('[storage] Railway storage off (no DATABASE_URL) — using Google Drive');
    return false;
  }
  await runMigrations();
  ready = parts.bucket && parts.encryption;
  console.log(ready
    ? '[storage] Railway storage ready (Postgres + encrypted bucket)'
    : `[storage] Railway storage incomplete (bucket: ${parts.bucket}, encryption key: ${parts.encryption}) — using Google Drive`);
  if (ready && schedule) scheduleBackups();
  return ready;
}

module.exports = { initRailwayStorage, isRailwayStorageReady };
