// One-time copies of the small Drive JSON files into Postgres. Safe to run
// again and again: every row keeps the id it had on Drive, so a second run
// inserts nothing new. Once a copy is complete a flag in app_settings tells
// the app to stop reading the Drive file, so nothing is ever shown twice.
//
// Student folders and their documents are moved by
// scripts/migrate-drive-to-railway.js (too big for app start-up).

const { query } = require('../db');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile } = require('./drive');
const { ownerOrgId } = require('./tenantScope');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getSetting(key) {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

async function readDriveJson(name) {
  const files = await findFilesByName(ROOT_FOLDER_ID(), name);
  if (!files.length) return { found: false, data: null };
  return { found: true, data: await readJsonFile(files[0].id) };
}

// audit_log.json → audit_log (Flyurdream's, as all Drive-era entries are)
async function importLegacyAuditLog({ log = console.log } = {}) {
  if (await getSetting('drive_audit_imported')) return { skipped: true };
  const { found, data } = await readDriveJson('audit_log.json');
  const entries = found && Array.isArray(data?.entries) ? data.entries : [];
  const orgId = await ownerOrgId();
  let inserted = 0;
  for (const e of entries) {
    if (!e?.action || !e?.ts) continue;
    const legacyId = String(e.id || `${e.ts}|${e.actor}|${e.action}|${e.target}`);
    const { rowCount } = await query(
      `INSERT INTO audit_log (org_id, ts, actor, role, action, target, details, legacy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING`,
      [orgId, e.ts, e.actor || 'unknown', e.role || '', e.action, e.target || '', e.details || null, legacyId],
    );
    inserted += rowCount;
  }
  await setSetting('drive_audit_imported', { at: new Date().toISOString(), entries: entries.length, inserted });
  log(`[import] audit_log.json: ${entries.length} entries, ${inserted} newly copied into Postgres`);
  return { entries: entries.length, inserted };
}

// banker_access_requests.json → banker_access_requests
async function importLegacyRequests({ log = console.log } = {}) {
  if (await getSetting('drive_requests_imported')) return { skipped: true };
  const { found, data } = await readDriveJson('banker_access_requests.json');
  const requests = found && Array.isArray(data?.requests) ? data.requests : [];
  const owner = await ownerOrgId();
  let inserted = 0;
  for (const r of requests) {
    if (!r?.id || !UUID_RE.test(r.id) || !r.studentKey || !r.bankerName) continue;
    const { rowCount } = await query(
      `INSERT INTO banker_access_requests
         (id, org_id, status, student_key, student_name, student_identifier, banker_name,
          requested_by, requested_by_role, requested_at, decided_by, decided_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING`,
      [r.id, r.orgId && UUID_RE.test(r.orgId) ? r.orgId : owner, ['pending', 'approved', 'rejected'].includes(r.status) ? r.status : 'pending',
        r.studentKey, r.studentName || '', r.studentIdentifier || '', r.bankerName, r.requestedBy || 'unknown',
        r.requestedByRole || 'advisor', r.requestedAt || new Date().toISOString(), r.decidedBy || null, r.decidedAt || null, r.note || null],
    );
    inserted += rowCount;
  }
  await setSetting('drive_requests_imported', { at: new Date().toISOString(), requests: requests.length, inserted });
  log(`[import] banker_access_requests.json: ${requests.length} requests, ${inserted} newly copied into Postgres`);
  return { requests: requests.length, inserted };
}

module.exports = { getSetting, setSetting, importLegacyAuditLog, importLegacyRequests };
