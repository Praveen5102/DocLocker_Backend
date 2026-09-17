const crypto = require('crypto');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByNameExcept, createJsonFile } = require('./drive');

// Keeps the file from growing forever — old entries roll off once the log
// passes this size. Generous enough that nothing an admin would actually
// want to look back on gets lost in normal use.
const MAX_ENTRIES = 2000;

async function readAuditLog() {
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

async function appendEntry({ actor, role, action, target, details }) {
  const entries = await readAuditLog();
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
function logAudit(entry) {
  _writeChain = _writeChain.then(() => appendEntry(entry)).catch((err) => {
    console.error('Audit log write failed:', err.message);
  });
}

module.exports = { readAuditLog, logAudit };
