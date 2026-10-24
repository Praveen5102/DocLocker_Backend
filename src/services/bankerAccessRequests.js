const crypto = require('crypto');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByNameExcept, createJsonFile } = require('./drive');
const { query, withTransaction, isDbEnabled } = require('../db');
const { ownerOrgId } = require('./tenantScope');

// Advisors can't grant a banker access to a student's documents unilaterally —
// each grant has to be reviewed by an admin first. This is the queue of those
// in-flight requests.
//
// Stored in Postgres (banker_access_requests) whenever a database is
// configured; the old Drive file (banker_access_requests.json) is copied in
// once by services/driveImport.js and is only used when there is no database.
const MAX_ENTRIES = 500;

async function readRequests() {
  const files = await findFilesByName(ROOT_FOLDER_ID(), 'banker_access_requests.json');
  if (files.length === 0) return [];
  try {
    const data = await readJsonFile(files[0].id);
    return Array.isArray(data.requests) ? data.requests : [];
  } catch (err) {
    console.warn('Failed to parse banker_access_requests.json:', err.message);
    return [];
  }
}

async function writeRequests(requests) {
  const trimmed = requests.slice(-MAX_ENTRIES);
  const newFile = await createJsonFile(ROOT_FOLDER_ID(), 'banker_access_requests.json', { requests: trimmed });
  await trashFilesByNameExcept(ROOT_FOLDER_ID(), 'banker_access_requests.json', newFile.id);
}

// Serializes read-modify-write calls against the single shared Drive file,
// same reasoning as auditLog.js's _writeChain — two advisors requesting (or
// a superadmin deciding) at nearly the same moment could otherwise race and
// silently drop one write. Unlike logAudit, callers here need the real
// result (and real errors), so this isn't fire-and-forget: each call gets
// its own awaited promise, while still running strictly after the previous
// one finishes. A rejected op is swallowed only in the chain itself (so it
// doesn't permanently wedge later calls) — the caller's own promise still
// rejects normally.
let _chain = Promise.resolve();
function withLock(fn) {
  const result = _chain.then(fn);
  _chain = result.catch(() => {});
  return result;
}

// ── Postgres ────────────────────────────────────────────────────────────
function toRequest(r) {
  return {
    id: r.id, status: r.status, orgId: r.org_id, studentKey: r.student_key, studentName: r.student_name,
    studentIdentifier: r.student_identifier, bankerName: r.banker_name, requestedBy: r.requested_by,
    requestedByRole: r.requested_by_role, requestedAt: r.requested_at?.toISOString?.() || r.requested_at,
    decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString?.() || r.decided_at || null, note: r.note,
  };
}

async function createRequestDb({ orgId, studentKey, studentName, studentIdentifier, bankerName, requestedBy, requestedByRole }) {
  const org = orgId || (await ownerOrgId());
  const { rows } = await query(
    `INSERT INTO banker_access_requests
       (id, org_id, student_key, student_name, student_identifier, banker_name, requested_by, requested_by_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, student_key, banker_name) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), org, studentKey, studentName || '', studentIdentifier || '', bankerName, requestedBy, requestedByRole || 'advisor'],
  );
  if (rows[0]) return { request: toRequest(rows[0]), created: true };
  const existing = await query(
    "SELECT * FROM banker_access_requests WHERE org_id = $1 AND student_key = $2 AND banker_name = $3 AND status = 'pending'",
    [org, studentKey, bankerName],
  );
  return { request: toRequest(existing.rows[0]), created: false };
}

async function decideRequestDb(id, { approve, decidedBy, note, visible }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return { error: 'not_found' };
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM banker_access_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return { error: 'not_found' };
    const request = toRequest(rows[0]);
    if (!(await visible(request))) return { error: 'not_found' };
    if (request.status !== 'pending') return { error: 'already_decided', request };
    const updated = await client.query(
      `UPDATE banker_access_requests SET status = $2, decided_by = $3, decided_at = now(), note = COALESCE($4, note)
        WHERE id = $1 RETURNING *`,
      [id, approve ? 'approved' : 'rejected', decidedBy, note ? String(note).trim() : null],
    );
    return { request: toRequest(updated.rows[0]) };
  });
}

// Oldest first, like the Drive file was.
async function listRequestsDb() {
  const { rows } = await query('SELECT * FROM banker_access_requests ORDER BY requested_at, id');
  return rows.map(toRequest);
}

// ── Drive (no database configured) ──────────────────────────────────────

// Creates a pending request, unless an identical one (same student + banker,
// still pending) already exists — returns that instead so a double-click or
// retry doesn't spam the approval queue with duplicates.
function createRequest(fields) {
  if (isDbEnabled()) return createRequestDb(fields);
  const { orgId, studentKey, studentName, studentIdentifier, bankerName, requestedBy, requestedByRole } = fields;
  return withLock(async () => {
    const requests = await readRequests();
    const existing = requests.find(
      (r) => r.status === 'pending' && r.studentKey === studentKey && r.bankerName === bankerName,
    );
    if (existing) return { request: existing, created: false };

    const entry = {
      id: crypto.randomUUID(),
      status: 'pending',
      studentKey,
      orgId: orgId || null, // company of the student; older requests (null) are Flyurdream's
      studentName: studentName || '',
      studentIdentifier: studentIdentifier || '',
      bankerName,
      requestedBy,
      requestedByRole: requestedByRole || 'advisor',
      requestedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      note: null,
    };
    requests.push(entry);
    await writeRequests(requests);
    return { request: entry, created: true };
  });
}

// Marks a pending request approved/rejected. Does NOT touch the student's
// sharedBankers list itself — the route calling this stays responsible for
// actually applying the grant on approval, same as the direct-grant path.
// visible(request) → false makes a request outside the caller's company
// look like it doesn't exist.
function decideRequest(id, { approve, decidedBy, note, visible = async () => true }) {
  if (isDbEnabled()) return decideRequestDb(id, { approve, decidedBy, note, visible });
  return withLock(async () => {
    const requests = await readRequests();
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || !(await visible(requests[idx]))) return { error: 'not_found' };

    const request = requests[idx];
    if (request.status !== 'pending') return { error: 'already_decided', request };

    request.status = approve ? 'approved' : 'rejected';
    request.decidedBy = decidedBy;
    request.decidedAt = new Date().toISOString();
    if (note) request.note = String(note).trim();

    await writeRequests(requests);
    return { request };
  });
}

async function listRequests() {
  if (isDbEnabled()) return listRequestsDb();
  return readRequests();
}

module.exports = { createRequest, decideRequest, listRequests };
