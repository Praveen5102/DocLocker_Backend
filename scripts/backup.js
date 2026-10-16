// npm run backup         — run a backup now (same as the nightly job)
// npm run backup:verify  — prove the latest backup restores: decrypts the
//                          newest snapshot and a sample of documents and
//                          checks them against their recorded checksums.
require('dotenv').config();
const { initRailwayStorage } = require('../src/db/startup');
const { runBackup, verifyLatestBackup } = require('../src/services/backup');
const { closeDb } = require('../src/db');

(async () => {
  try {
    if (!(await initRailwayStorage())) throw new Error('Railway storage is not configured');
    if (process.argv[2] === 'verify') {
      const r = await verifyLatestBackup({ sample: 5 });
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.objectsOk === r.objectsChecked ? 0 : 1;
    } else {
      const r = await runBackup();
      process.exitCode = r.status === 'ok' ? 0 : 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
})();
