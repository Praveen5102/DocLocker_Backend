// Readable PDF backups in Drive (services/pdfBackup.js), on demand.
//
//   npm run backup:pdf                     every student; skips up-to-date ones
//   npm run backup:pdf -- --force          every student, rebuilt
//   npm run backup:pdf -- --student "<record key>"   one student, rebuilt
//
// Writes to the Drive this backend is connected to, so run it where that is
// the Drive you mean (production).
require('dotenv').config();
const { initRailwayStorage } = require('../src/db/startup');
const { runWeekly, backupStudent } = require('../src/services/pdfBackup');
const { query, closeDb } = require('../src/db');
const { ownerOrgId } = require('../src/services/tenantScope');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

(async () => {
  try {
    if (!(await initRailwayStorage({ imports: false }))) throw new Error('Railway storage is not configured');
    const key = arg('--student');
    if (key) {
      const { rows } = await query("SELECT org_id FROM students WHERE folder_key = $1 AND source = 'railway' LIMIT 1", [key]);
      const orgId = rows[0]?.org_id || (await ownerOrgId());
      const r = await backupStudent({ key, orgId }, { force: true });
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.status === 'saved' ? 0 : 1;
    } else {
      const r = await runWeekly({ kind: 'manual', force: process.argv.includes('--force') });
      process.exitCode = r.status === 'ok' ? 0 : 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
})();
