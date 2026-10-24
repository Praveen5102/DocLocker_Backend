const crypto = require('crypto');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByNameExcept, createJsonFile } = require('./drive');
const { query } = require('../db');
const { isRailwayStorageReady } = require('../db/startup');
const { currentScope, ownerOrgId, scopeOrgIds, includesOwner } = require('./tenantScope');

// Where entries go:
//   - Railway storage ready → Postgres (audit_log table). No size cap, so
//     high-volume entries like document views never push out important
//     ones like approvals or deletions.
//   - otherwise → the audit_log.json file in Drive, as before.
// Reads merge both, so the history from before the switch stays visible.
//
// Each entry belongs to the company of whoever acted: a signed-in account's
// own company, or a student's signup-link company. So Flyurdream staff's
// actions — even on a partner's students or settings — stay in Flyurdream's
// log and never show up in a partner's. Reads only return the companies the
// caller may see. Drive-era entries all belong to Flyurdream.

// How many Postgres entries a read pulls in (newest first). The API caps
// what it returns per request well below this.
const DB_READ_LIMIT = 5000;

// Keeps the file from growing forever — old entries roll off once the log
// passes this size. Generous enough that nothing an admin would actually
// want to look back on gets lost in normal use.
const MAX_ENTRIES = 2000;

// Set once services/driveImport.js has copied audit_log.json into Postgres;
// from then on the Drive file is never read, so no entry shows twice.
let driveImported = false;
async function driveAlreadyImported() {
  if (driveImported || !isRailwayStorageReady()) return driveImported;
  const { rows } = await query("SELECT 1 FROM app_settings WHERE key = 'drive_audit_imported'");
  driveImported = rows.length > 0;
  return driveImported;
}

async function readDriveAuditLog() {
  if (!(await includesOwner())) return [];
  if (await driveAlreadyImported()) return [];
  const files = await findFilesByName(ROOT_FOLDER_ID(), 'audit_log.json');
  if (files.length === 0) return [];
  try {
    const data = await readJsonFile(files[0].id);
    return Array.isArray(data.entries) ? data.entries : [];
  } catch (err) {
    console.warn('Failed to parse audit_log.json:', err.message);
    return [];
  }
}

async function readDbAuditLog() {
  if (!isRailwayStorageReady()) return [];
  const { rows } = await query(
    `SELECT id, ts, actor, role, action, target, details FROM audit_log
      WHERE ($1::uuid[] IS NULL OR org_id = ANY($1::uuid[])) ORDER BY ts DESC, id DESC LIMIT $2`,
    [await scopeOrgIds(), DB_READ_LIMIT],
  );
  return rows.reverse().map((r) => ({
    id: `db-${r.id}`, ts: r.ts.toISOString(), actor: r.actor, role: r.role || '',
    action: r.action, target: r.target || '', details: r.details,
  }));
}

// Oldest first, Drive history followed by everything since the switch.
async function readAuditLog() {
  const [driveEntries, dbEntries] = await Promise.all([readDriveAuditLog(), readDbAuditLog()]);
  return [...driveEntries, ...dbEntries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

async function writeAuditLog(entries) {
  const trimmed = entries.slice(-MAX_ENTRIES);
  const newFile = await createJsonFile(ROOT_FOLDER_ID(), 'audit_log.json', { entries: trimmed });
  await trashFilesByNameExcept(ROOT_FOLDER_ID(), 'audit_log.json', newFile.id);
}

// Serializes appends within this process — audit writes are read-modify-write
// against one shared Drive file, so two calls firing close together (two
// admins acting at once) could otherwise race and silently drop one entry.
// This chain closes that window for calls handled by this process; it does
// not coordinate across multiple server instances (this app already assumes
// a single instance elsewhere — see the createLock comment in drive.js).
let _writeChain = Promise.resolve();

async function appendEntry({ orgId, actor, role, action, target, details }) {
  if (isRailwayStorageReady()) {
    await query(
      'INSERT INTO audit_log (org_id, actor, role, action, target, details) VALUES ($1, $2, $3, $4, $5, $6)',
      [await orgId, actor || 'unknown', role || '', action, target || '', details || null],
    );
    return;
  }
  const entries = await readDriveAuditLog();
  entries.push({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    actor: actor || 'unknown',
    role: role || '',
    action,
    target: target || '',
    details: details || null,
  });
  await writeAuditLog(entries);
}

// Fire-and-forget by design — an audit-log write must never delay or fail
// the real admin action it's recording. Failures are logged, not thrown.
// The company is read now, inside the request, not later in the queue.
// entry.orgId only applies outside a request scope (e.g. sign-in, before
// there is a signed-in account).
function logAudit(entry) {
  const scope = currentScope();
  const orgId = scope ? scope.homeOrgId : (entry.orgId || ownerOrgId());
  orgId.catch?.(() => {});
  _writeChain = _writeChain.then(() => appendEntry({ ...entry, orgId })).catch((err) => {
    console.error('Audit log write failed:', err.message);
  });
}

module.exports = { readAuditLog, logAudit };
