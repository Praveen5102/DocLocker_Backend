// Offsite backups of Railway storage, to a dedicated Google Drive folder.
//
// Railway buckets have no versioning or backups of their own, so every
// night this copies:
//   - a full database snapshot (gzip, then encrypted with the "backups" key)
//   - every bucket object not yet copied, byte-for-byte — they are already
//     encrypted, so Drive only ever holds ciphertext
//
// Nothing readable leaves Railway: without DATA_ENCRYPTION_KEY the backup
// folder is useless to anyone who opens it. That also means the key itself
// must be kept safe separately — a backup can't be restored without it.
//
// Retention: the newest 30 snapshots are kept; a copied object whose
// document no longer exists (student deleted) is removed after 30 days,
// so deletions reach the backups too.

const zlib = require('zlib');
const { Readable } = require('stream');
const { query, getPool } = require('../db');
const { encrypt, decrypt } = require('./dataCrypto');
const { getRaw } = require('./objectStore');
const { getDrive, getOrCreate, readFileBuffer } = require('./drive');

const LOCK_ID = 727302;
const KEEP_SNAPSHOTS = 30;
const ORPHAN_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const folderName = () => process.env.BACKUP_DRIVE_FOLDER_NAME || 'DocLocker_Backups';

// My Drive → DocLocker_Backups → { database, documents }. Deliberately NOT
// under ROOT_FOLDER_ID, which the app treats as "one folder per student".
async function backupFolders() {
  const root = process.env.BACKUP_DRIVE_FOLDER_ID
    ? { id: process.env.BACKUP_DRIVE_FOLDER_ID }
    : await getOrCreate('root', folderName());
  const [database, documents] = await Promise.all([
    getOrCreate(root.id, 'database'),
    getOrCreate(root.id, 'documents'),
  ]);
  return { root, database, documents };
}

async function listAll(parentId, fields = 'id, name, createdTime') {
  const drive = getDrive();
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${fields})`,
      orderBy: 'createdTime desc',
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function upload(parentId, name, buffer) {
  const res = await getDrive().files.create({
    requestBody: { name, parents: [parentId], mimeType: 'application/octet-stream' },
    media: { mimeType: 'application/octet-stream', body: Readable.from(buffer) },
    fields: 'id',
  });
  return res.data.id;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

async function buildSnapshot() {
  const [orgs, students, documents, migrations] = await Promise.all([
    query('SELECT * FROM organizations ORDER BY created_at'),
    query('SELECT * FROM students ORDER BY created_at'),
    query('SELECT * FROM documents ORDER BY created_at'),
    query('SELECT version FROM schema_migrations ORDER BY version'),
  ]);
  const bytea = (row) => Object.fromEntries(Object.entries(row).map(
    ([k, v]) => [k, Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v],
  ));
  const snapshot = {
    format: 'doclocker-backup-v1',
    createdAt: new Date().toISOString(),
    migrations: migrations.rows.map((r) => r.version),
    tables: {
      organizations: orgs.rows.map(bytea),
      students: students.rows.map(bytea),
      documents: documents.rows.map(bytea),
    },
  };
  return snapshot;
}

const sealSnapshot = (snapshot) => encrypt(zlib.gzipSync(Buffer.from(JSON.stringify(snapshot))), 'backups');
const openSnapshot = (buf) => JSON.parse(zlib.gunzipSync(decrypt(buf, 'backups')).toString('utf8'));

// ── Run ──────────────────────────────────────────────────────────────────────

async function runBackup({ log = console.log } = {}) {
  // One run at a time, even across instances or a redeploy mid-run.
  const lockClient = await getPool().connect();
  const { rows: [{ locked }] } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
  if (!locked) {
    lockClient.release();
    log('[backup] another backup is already running — skipped');
    return { skipped: true };
  }

  const { rows: [run] } = await query('INSERT INTO backup_runs DEFAULT VALUES RETURNING id');
  const details = { snapshot: null, copied: 0, copyFailed: 0, snapshotsPruned: 0, objectsPruned: 0 };
  try {
    const folders = await backupFolders();

    // 1. Database snapshot.
    const snapshot = await buildSnapshot();
    const sealed = sealSnapshot(snapshot);
    const name = `db-${snapshot.createdAt.replace(/[:.]/g, '-')}.bin`;
    await upload(folders.database.id, name, sealed);
    details.snapshot = { name, bytes: sealed.length, students: snapshot.tables.students.length, documents: snapshot.tables.documents.length };

    // 2. Objects not yet copied (ciphertext as stored — never decrypted here).
    const { rows: pending } = await query(
      "SELECT id, storage_key FROM documents WHERE storage = 'bucket' AND backed_up_at IS NULL ORDER BY created_at",
    );
    for (const doc of pending) {
      try {
        const fileId = await upload(folders.documents.id, doc.id, await getRaw(doc.storage_key));
        await query('UPDATE documents SET backed_up_at = now(), backup_file_id = $2 WHERE id = $1', [doc.id, fileId]);
        details.copied += 1;
      } catch (err) {
        details.copyFailed += 1;
        log(`[backup] could not copy document ${doc.id}: ${err.message}`);
      }
    }

    // 3. Retention.
    const drive = getDrive();
    const snapshots = (await listAll(folders.database.id)).filter((f) => /^db-.*\.bin$/.test(f.name));
    for (const old of snapshots.slice(KEEP_SNAPSHOTS)) {
      await drive.files.delete({ fileId: old.id });
      details.snapshotsPruned += 1;
    }
    const { rows: live } = await query('SELECT id::text FROM documents');
    const liveIds = new Set(live.map((r) => r.id));
    const cutoff = Date.now() - ORPHAN_GRACE_DAYS * DAY_MS;
    for (const f of await listAll(folders.documents.id)) {
      if (!liveIds.has(f.name) && Date.parse(f.createdTime) < cutoff) {
        await drive.files.delete({ fileId: f.id });
        details.objectsPruned += 1;
      }
    }

    const status = details.copyFailed ? 'failed' : 'ok';
    await query('UPDATE backup_runs SET finished_at = now(), status = $2, details = $3 WHERE id = $1', [run.id, status, details]);
    log(`[backup] ${status}: snapshot ${details.snapshot.students} students / ${details.snapshot.documents} documents, ` +
        `${details.copied} new object(s) copied${details.copyFailed ? `, ${details.copyFailed} FAILED` : ''}`);
    return { status, ...details };
  } catch (err) {
    await query("UPDATE backup_runs SET finished_at = now(), status = 'failed', details = $2 WHERE id = $1",
      [run.id, { ...details, error: err.message }]).catch(() => {});
    log(`[backup] FAILED: ${err.message}`);
    return { status: 'failed', error: err.message, ...details };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    lockClient.release();
  }
}

// ── Verify (proves the latest backup can actually be restored) ──────────────

async function verifyLatestBackup({ sample = 3 } = {}) {
  const folders = await backupFolders();
  const [latest] = (await listAll(folders.database.id)).filter((f) => /^db-.*\.bin$/.test(f.name));
  if (!latest) throw new Error('No database snapshot found');

  const snapshot = openSnapshot(await readFileBuffer(latest.id));
  const backedUp = snapshot.tables.documents.filter((d) => d.backup_file_id);
  const picks = backedUp.sort(() => Math.random() - 0.5).slice(0, sample);

  const crypto = require('crypto');
  const objects = [];
  for (const d of picks) {
    const plaintext = decrypt(await readFileBuffer(d.backup_file_id), 'files');
    const ok = crypto.createHash('sha256').update(plaintext).digest('hex') === d.sha256;
    objects.push({ id: d.id, ok });
  }
  return {
    snapshot: latest.name,
    createdAt: snapshot.createdAt,
    students: snapshot.tables.students.length,
    documents: snapshot.tables.documents.length,
    objectsChecked: objects.length,
    objectsOk: objects.filter((o) => o.ok).length,
  };
}

// ── Schedule ─────────────────────────────────────────────────────────────────

// Nightly at 02:00 IST (20:30 UTC), plus a catch-up run shortly after boot
// if the last good backup is more than 26 hours old — so frequent
// redeploys can never quietly skip a night. Opt-in with BACKUP_ENABLED=true
// (set on the production service only).
function scheduleBackups() {
  if (process.env.BACKUP_ENABLED !== 'true') {
    console.log('[backup] nightly backups off (BACKUP_ENABLED is not "true")');
    return;
  }
  const safeRun = () => runBackup().catch((err) => console.error('[backup] run crashed:', err.message));

  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 30));
  if (next <= now) next.setTime(next.getTime() + DAY_MS);
  setTimeout(() => {
    safeRun();
    setInterval(safeRun, DAY_MS).unref();
  }, next - now).unref();

  setTimeout(async () => {
    try {
      const { rows } = await query(
        "SELECT max(finished_at) AS last FROM backup_runs WHERE status = 'ok'",
      );
      const last = rows[0].last ? rows[0].last.getTime() : 0;
      if (Date.now() - last > 26 * 60 * 60 * 1000) safeRun();
    } catch (err) {
      console.error('[backup] catch-up check failed:', err.message);
    }
  }, 5 * 60 * 1000).unref();

  console.log(`[backup] nightly backups on — next run ${next.toISOString()}`);
}

module.exports = { runBackup, verifyLatestBackup, scheduleBackups, backupFolders };
