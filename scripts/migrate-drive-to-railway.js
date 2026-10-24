#!/usr/bin/env node
// Moves everything still on Google Drive into Railway:
//   - staff accounts (admins.json)                 → accounts           (also done at app start)
//   - audit log (audit_log.json)                   → audit_log          (also done at app start)
//   - lender access requests                       → banker_access_requests (also done at app start)
//   - every Drive student folder: the record       → students (encrypted)
//                                 every document   → bucket (encrypted) + documents
//
// Quality rules:
//   - Nothing is copied twice. Every Drive folder and file copied is recorded
//     (drive_migration_students / drive_migration_files); a re-run skips them,
//     so the script can be stopped and resumed at any point.
//   - Every download is checked against Drive's own MD5, and every stored file
//     gets a SHA-256 the app verifies on each read.
//   - Duplicate copies inside one Drive folder (same section + name) keep only
//     the newest; older ones are reported, not copied.
//   - A student only switches to Railway once ALL their files and their record
//     are in — in one step. Until then the app keeps using their Drive folder.
//   - Drive is never modified or deleted. It stays as a backup.
//
// Usage (from the Backend folder):
//   node scripts/migrate-drive-to-railway.js --dry-run         # report only, copies nothing
//   node scripts/migrate-drive-to-railway.js                   # do it
//   node scripts/migrate-drive-to-railway.js --only "<folder>" # one student
//   node scripts/migrate-drive-to-railway.js --limit 5         # first N students
//   node scripts/migrate-drive-to-railway.js --verify          # re-read and check everything moved
//   --report <file.json>   write the full report to a file

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const { query, withTransaction } = require('../src/db');
const { initRailwayStorage, isRailwayStorageReady } = require('../src/db/startup');
const { getDrive, ROOT_FOLDER_ID, readFileBuffer } = require('../src/services/drive');
const { readStudentMeta } = require('../src/services/studentMeta');
const { documentKey, putEncrypted, getDecrypted, deleteObject } = require('../src/services/objectStore');
const { encryptJson } = require('../src/services/dataCrypto');
const { writeMeta } = require('../src/services/studentStore');
const { ownerOrgId } = require('../src/services/tenantScope');
const accounts = require('../src/services/accounts');
const driveImport = require('../src/services/driveImport');

// ── options ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const VERIFY = flag('--verify');
const ONLY = opt('--only');
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;
const REPORT = opt('--report');
const FILE_CONCURRENCY = 3;

const GOOGLE_NATIVE = /^application\/vnd\.google-apps\./;
const SKIP_NAMES = new Set(['student_meta.json']);
const toPublicId = (uuid) => `rw_${uuid}`;
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const log = (...a) => console.log(...a);

// ── Drive listing with checksums and dates (paged) ──
async function listChildren(folderId) {
  const drive = getDrive();
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime, createdTime)',
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function listTree(folderId, path = '') {
  const items = await listChildren(folderId);
  const files = [];
  for (const it of items) {
    if (it.mimeType === 'application/vnd.google-apps.folder') {
      files.push(...(await listTree(it.id, path ? `${path}/${it.name}` : it.name)));
    } else {
      files.push({ ...it, section: path || 'Others' });
    }
  }
  return files;
}

// Which Drive files to copy: newest of each section + name, no Google
// Docs/Sheets (they have no file bytes), no student_meta.json (that becomes
// the encrypted record itself).
function planFiles(all) {
  const skipped = [];
  const bySlot = new Map();
  for (const f of all) {
    if (SKIP_NAMES.has(f.name.toLowerCase())) continue;
    if (GOOGLE_NATIVE.test(f.mimeType)) { skipped.push({ ...f, reason: 'Google Docs/Sheets file (no file content to copy)' }); continue; }
    const slot = `${f.section}\u0000${f.name.toLowerCase()}`;
    const prev = bySlot.get(slot);
    if (!prev) { bySlot.set(slot, f); continue; }
    const newer = Date.parse(f.modifiedTime) > Date.parse(prev.modifiedTime) ? f : prev;
    const older = newer === f ? prev : f;
    bySlot.set(slot, newer);
    skipped.push({ ...older, reason: `older duplicate of ${newer.section}/${newer.name}` });
  }
  return { keep: [...bySlot.values()], skipped };
}

// Points the record's upload slots at the copied documents.
function rewriteUploads(meta, idMap) {
  const dangling = [];
  let rewritten = 0;
  for (const [section, fields] of Object.entries(meta.uploads || {})) {
    if (!fields || typeof fields !== 'object') continue;
    for (const [field, info] of Object.entries(fields)) {
      if (!info || typeof info !== 'object') continue;
      const driveId = info.id || info.fileId;
      if (!driveId || String(driveId).startsWith('rw_')) continue;
      const rw = idMap.get(driveId);
      if (rw) {
        fields[field] = { ...info, id: rw, fileId: rw };
        delete fields[field].webViewLink;
        rewritten += 1;
      } else {
        dangling.push(`${section}.${field} (${info.name || driveId})`);
      }
    }
  }
  delete meta.driveUrl;
  return { rewritten, dangling };
}

async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }));
  return results;
}

// ── one student folder ──
async function migrateFolder(folder, ownerId) {
  const r = { folder: folder.name, status: '', files: 0, copied: 0, reused: 0, skipped: [], errors: [], dangling: [], bytes: 0 };
  const done = await query('SELECT status, student_id FROM drive_migration_students WHERE drive_folder_id = $1', [folder.id]);
  if (done.rows[0]?.status === 'done') { r.status = done.rows[0].student_id ? 'already moved' : 'moved, then deleted in the app — not restored'; return r; }

  const [{ meta, fileId: metaFileId }, tree] = await Promise.all([readStudentMeta(folder.id), listTree(folder.id)]);
  const { keep, skipped } = planFiles(tree);
  r.files = keep.length;
  r.skipped = skipped.map((f) => `${f.section}/${f.name}: ${f.reason}`);
  r.bytes = keep.reduce((n, f) => n + Number(f.size || 0), 0);
  if (!metaFileId && keep.length === 0) { r.status = 'not a student folder (no record, no files) — left alone'; return r; }

  // A Railway student with this key that we did NOT create would be a clash.
  const clash = await query(
    "SELECT s.id FROM students s WHERE s.org_id = $1 AND s.folder_key = $2 AND s.source = 'railway' AND NOT EXISTS (SELECT 1 FROM drive_migration_students m WHERE m.student_id = s.id)",
    [ownerId, folder.name],
  );
  if (clash.rows[0]) { r.status = 'CONFLICT: a Railway student already uses this key — needs a manual merge'; return r; }

  if (DRY) { r.status = 'would move'; return r; }

  // Student row (hidden from the app until the final switch: source drive_import)
  const sep = folder.name.indexOf('__');
  await query(
    `INSERT INTO students (org_id, folder_key, name, identifier, record_enc, source, created_at)
     VALUES ($1, $2, $3, $4, $5, 'drive_import', COALESCE($6::timestamptz, now()))
     ON CONFLICT (org_id, folder_key) DO NOTHING`,
    [ownerId, folder.name, String(meta.name || (sep >= 0 ? folder.name.slice(0, sep) : folder.name)).slice(0, 300),
      sep >= 0 ? folder.name.slice(sep + 2) : null, encryptJson({}), meta.createdAt || null],
  );
  const { rows: [student] } = await query('SELECT id FROM students WHERE org_id = $1 AND folder_key = $2', [ownerId, folder.name]);
  await query(
    `INSERT INTO drive_migration_students (drive_folder_id, folder_key, student_id, meta_drive_file_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (drive_folder_id) DO NOTHING`,
    [folder.id, folder.name, student.id, metaFileId],
  );

  const copyOne = async (f) => {
    const seen = await query('SELECT document_id FROM drive_migration_files WHERE drive_file_id = $1', [f.id]);
    if (seen.rows[0]?.document_id) { r.reused += 1; return; }
    try {
      const buffer = await readFileBuffer(f.id);
      if (f.md5Checksum && md5(buffer) !== f.md5Checksum) throw new Error('download did not match Drive’s checksum');
      const documentId = crypto.randomUUID();
      const key = documentKey({ orgId: ownerId, studentId: student.id, documentId });
      const stored = await putEncrypted(key, buffer);
      try {
        await withTransaction(async (client) => {
          // A same-named live copy (re-run after a crash between steps) is replaced
          await client.query(
            'UPDATE documents SET deleted_at = now() WHERE student_id = $1 AND section = $2 AND lower(file_name) = lower($3) AND deleted_at IS NULL',
            [student.id, f.section, f.name],
          );
          await client.query(
            `INSERT INTO documents (id, org_id, student_id, section, file_name, mime_type, size_bytes,
                                    storage, storage_key, encryption, sha256, uploaded_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'bucket', $8, $9, $10, 'drive-migration', COALESCE($11::timestamptz, now()))`,
            [documentId, ownerId, student.id, f.section, f.name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200),
              f.mimeType || 'application/octet-stream', stored.sizeBytes, key, stored.encryption, stored.sha256, f.modifiedTime || null],
          );
          await client.query(
            'INSERT INTO drive_migration_files (drive_file_id, drive_folder_id, document_id, drive_md5, sha256) VALUES ($1, $2, $3, $4, $5)',
            [f.id, folder.id, documentId, f.md5Checksum || null, stored.sha256],
          );
        });
      } catch (err) {
        await deleteObject(key).catch(() => {});
        throw err;
      }
      r.copied += 1;
    } catch (err) {
      r.errors.push(`${f.section}/${f.name}: ${err.message}`);
    }
  };
  await pool(keep, FILE_CONCURRENCY, copyOne);
  if (r.errors.length) { r.status = 'incomplete — re-run to retry the failed files (student stays on Drive)'; return r; }

  // Final sync: anything uploaded to Drive while we were copying?
  const late = planFiles(await listTree(folder.id)).keep.filter((f) => !keep.some((k) => k.id === f.id));
  for (const f of late) await copyOne(f);
  if (r.errors.length) { r.status = 'incomplete — re-run to retry the failed files (student stays on Drive)'; return r; }
  r.files += late.length;

  // Record: re-read (it may have changed while copying), point uploads at the copies
  const { meta: latest } = await readStudentMeta(folder.id);
  const { rows: mapped } = await query('SELECT drive_file_id, document_id FROM drive_migration_files WHERE drive_folder_id = $1 AND document_id IS NOT NULL', [folder.id]);
  const idMap = new Map(mapped.map((m) => [m.drive_file_id, toPublicId(m.document_id)]));
  const { dangling } = rewriteUploads(latest, idMap);
  r.dangling = dangling;

  // The switch: record saved, student visible on Railway, folder marked done
  await writeMeta({ kind: 'railway', key: folder.name, studentId: student.id, orgId: ownerId }, latest);
  await withTransaction(async (client) => {
    await client.query("UPDATE students SET source = 'railway' WHERE id = $1", [student.id]);
    await client.query(
      `UPDATE drive_migration_students SET status = 'done', files_found = $2, files_copied = $3, files_skipped = $4, finished_at = now()
        WHERE drive_folder_id = $1`,
      [folder.id, r.files, r.copied + r.reused, r.skipped.length],
    );
  });
  r.status = 'moved';
  return r;
}

// ── --verify: every moved file readable and intact; nothing new left on Drive ──
async function verifyAll(folders) {
  const out = [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const { rows: moved } = await query("SELECT * FROM drive_migration_students WHERE status = 'done' ORDER BY folder_key");
  for (const m of moved) {
    const v = { folder: m.folder_key, files: 0, ok: 0, problems: [] };
    if (!m.student_id) { v.problems.push('student deleted in the app after the move'); out.push(v); continue; }
    const { rows: docs } = await query(
      `SELECT f.drive_file_id, d.storage_key, d.sha256, d.file_name, d.deleted_at FROM drive_migration_files f
         LEFT JOIN documents d ON d.id = f.document_id WHERE f.drive_folder_id = $1`,
      [m.drive_folder_id],
    );
    v.files = docs.length;
    for (const d of docs) {
      if (!d.storage_key) { v.problems.push(`${d.drive_file_id}: document row missing`); continue; }
      if (d.deleted_at) { v.ok += 1; continue; } // replaced later in the app — fine
      try { await getDecrypted(d.storage_key, d.sha256); v.ok += 1; } catch (err) { v.problems.push(`${d.file_name}: ${err.message}`); }
    }
    const folder = byId.get(m.drive_folder_id);
    if (folder) {
      const { keep } = planFiles(await listTree(folder.id));
      const copied = new Set(docs.map((d) => d.drive_file_id));
      const missing = keep.filter((f) => !copied.has(f.id));
      if (missing.length) v.problems.push(`${missing.length} Drive file(s) added after the move: ${missing.map((f) => f.name).join(', ')}`);
    }
    out.push(v);
  }
  return out;
}

(async () => {
  const started = Date.now();
  if (!(await initRailwayStorage({ imports: false })) || !isRailwayStorageReady()) {
    console.error('Railway storage is not ready (database, bucket and DATA_ENCRYPTION_KEY are all required). Nothing was done.');
    process.exit(1);
  }
  const ownerId = await ownerOrgId();
  const folders = (await listChildren(ROOT_FOLDER_ID()))
    .filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
    .sort((a, b) => a.name.localeCompare(b.name));

  if (VERIFY) {
    const v = await verifyAll(folders);
    const bad = v.filter((x) => x.problems.length);
    for (const x of v) log(`${x.problems.length ? 'PROBLEM' : 'OK     '}  ${x.folder}  ${x.ok}/${x.files} files${x.problems.length ? '  — ' + x.problems.join('; ') : ''}`);
    const notMoved = folders.length - v.length;
    log(`\n${v.length} moved students checked, ${bad.length} with problems; ${notMoved} Drive folder(s) not moved yet.`);
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ verifiedAt: new Date().toISOString(), results: v }, null, 2));
    process.exit(bad.length ? 1 : 0);
  }

  log(DRY ? '— DRY RUN: nothing will be copied or changed —\n' : '');
  // Small JSON files first (each is idempotent and also runs at app start)
  if (!DRY) {
    await accounts.importLegacyAccounts();
    await accounts.backfillEmailsFromNames();
    await driveImport.importLegacyAuditLog();
    await driveImport.importLegacyRequests();
  }

  const targets = folders.filter((f) => !ONLY || f.name === ONLY).slice(0, LIMIT);
  if (ONLY && !targets.length) { console.error(`No Drive folder named "${ONLY}".`); process.exit(1); }
  log(`${targets.length} Drive student folder(s) to process\n`);

  const results = [];
  for (const [i, folder] of targets.entries()) {
    let r;
    try {
      r = await migrateFolder(folder, ownerId);
    } catch (err) {
      r = { folder: folder.name, status: `ERROR: ${err.message}`, files: 0, copied: 0, reused: 0, skipped: [], errors: [err.message], dangling: [], bytes: 0 };
    }
    results.push(r);
    const mb = (r.bytes / 1048576).toFixed(1);
    log(`[${i + 1}/${targets.length}] ${r.folder} — ${r.status} · ${r.files} file(s), ${mb} MB${r.copied ? ` · copied ${r.copied}` : ''}${r.reused ? ` · already had ${r.reused}` : ''}`);
    for (const s of r.skipped) log(`      skipped  ${s}`);
    for (const e of r.errors) log(`      FAILED   ${e}`);
    for (const d of r.dangling) log(`      note     record points to a file no longer in Drive: ${d}`);
  }

  const count = (pred) => results.filter(pred).length;
  const summary = {
    mode: DRY ? 'dry-run' : 'run',
    folders: results.length,
    moved: count((r) => r.status === 'moved'),
    wouldMove: count((r) => r.status === 'would move'),
    alreadyMoved: count((r) => r.status.startsWith('already') || r.status.startsWith('moved, then')),
    incomplete: count((r) => r.status.startsWith('incomplete') || r.status.startsWith('ERROR')),
    conflicts: count((r) => r.status.startsWith('CONFLICT')),
    notStudents: count((r) => r.status.startsWith('not a student')),
    filesCopied: results.reduce((n, r) => n + r.copied, 0),
    duplicatesSkipped: results.reduce((n, r) => n + r.skipped.filter((s) => s.includes('older duplicate')).length, 0),
    googleDocsSkipped: results.reduce((n, r) => n + r.skipped.filter((s) => s.includes('Google Docs')).length, 0),
    totalMB: Number((results.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(1)),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  log('\nSummary', summary);
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ summary, results }, null, 2));
  process.exit(summary.incomplete || summary.conflicts ? 1 : 0);
})().catch((err) => {
  console.error('Migration stopped:', err.message);
  process.exit(1);
});
