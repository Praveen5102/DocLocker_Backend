const crypto = require('crypto');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByNameExcept, createJsonFile } = require('./drive');

// Advisors can't grant a banker access to a student's documents unilaterally —
// each grant has to be reviewed by a superadmin first. This is the queue of
// those in-flight requests, stored the same way audit_log.json is: one
// top-level JSON file on Drive, read-modify-write, newest copy written before
// the old one is trashed so a mid-write failure never leaves zero copies.
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

// Creates a pending request, unless an identical one (same student + banker,
// still pending) already exists — returns that instead so a double-click or
// retry doesn't spam the approval queue with duplicates.
function createRequest({ studentKey, studentName, studentIdentifier, bankerName, requestedBy, requestedByRole }) {
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
function decideRequest(id, { approve, decidedBy, note }) {
  return withLock(async () => {
    const requests = await readRequests();
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1) return { error: 'not_found' };

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
  return readRequests();
}

module.exports = { createRequest, decideRequest, listRequests };
