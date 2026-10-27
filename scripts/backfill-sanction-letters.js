#!/usr/bin/env node
// Records sanction letters uploaded before letters were tracked on the
// student. For every sanctioned or disbursed student without
// meta.sanctionLetter, looks for Loan_Documents/Sanction_Letter.* in their
// file and, when found, writes meta.sanctionLetter. Nothing is uploaded,
// moved or deleted; a student with no letter is only reported.
//
// Usage (from the Backend folder, with the environment you want to update):
//   node scripts/backfill-sanction-letters.js           # report only (default)
//   node scripts/backfill-sanction-letters.js --apply   # write the records

require('dotenv').config();
const { initRailwayStorage } = require('../src/db/startup');
const { ROOT_FOLDER_ID, listFolders } = require('../src/services/drive');
const { resolveStudent, readMeta, updateMeta, listRailwayStudents } = require('../src/services/studentStore');
const { findSanctionLetter } = require('../src/services/sanctionLetter');
const { runWithScope, ownerOrgId } = require('../src/services/tenantScope');

const APPLY = process.argv.includes('--apply');
const DONE = new Set(['sanctioned', 'disbursed']);

async function main() {
  await initRailwayStorage({ imports: false });
  // Every company: this is an operator script, not a staff request
  await runWithScope({ orgIds: null, homeOrgId: await ownerOrgId() }, async () => {
    const railway = await listRailwayStudents();
    const moved = new Set(railway.map((s) => s.studentKey));
    const driveKeys = (await listFolders(ROOT_FOLDER_ID())).map((f) => f.name).filter((k) => !moved.has(k));
    const keys = [...railway.map((s) => s.studentKey), ...driveKeys];

    const report = { checked: 0, sanctioned: 0, alreadyRecorded: 0, found: 0, missing: [] };
    for (const key of keys) {
      report.checked += 1;
      const ref = await resolveStudent(key);
      if (!ref) continue;
      const meta = await readMeta(ref).catch(() => null);
      if (!meta || !DONE.has(meta.loanStatus)) continue;
      report.sanctioned += 1;
      if (meta.sanctionLetter) { report.alreadyRecorded += 1; continue; }

      const letter = await findSanctionLetter(ref).catch((err) => {
        console.warn(`  ${key}: could not list files (${err.message})`);
        return null;
      });
      if (!letter) { report.missing.push(key); continue; }
      report.found += 1;
      console.log(`  ${APPLY ? 'recording' : 'would record'} ${letter.name} for ${key}`);
      if (APPLY) {
        await updateMeta(ref, (m) => {
          if (!m.sanctionLetter) m.sanctionLetter = { ...letter, uploadedBy: 'backfill' };
        });
      }
    }

    console.log('\nStudents checked:          ', report.checked);
    console.log('Sanctioned or disbursed:   ', report.sanctioned);
    console.log('  letter already recorded: ', report.alreadyRecorded);
    console.log(`  letter found ${APPLY ? '(recorded)' : '(not written: dry run)'}:`, report.found);
    console.log('  no letter in the file:   ', report.missing.length);
    for (const k of report.missing) console.log('    -', k);
    if (!APPLY && report.found) console.log('\nRun again with --apply to record the letters found.');
  });
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
