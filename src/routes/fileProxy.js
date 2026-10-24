const crypto = require('crypto');
const express = require('express');
const archiver = require('archiver');
const {
  ROOT_FOLDER_ID, findFolderByName, findStudentFolderKeyForFile, getFileContentStream, readFileBuffer,
} = require('../services/drive');
const { isRailwayFileId, getDocument, readDocumentBytes, resolveStudent } = require('../services/studentStore');
const { canSeeStudent } = require('../services/access');
const { includesOwner } = require('../services/tenantScope');
const { issueTicket, TTL_SECONDS } = require('../services/fileTickets');
const { logAudit } = require('../services/auditLog');
const { verifyJWT, verifyJWTOrTicket, requireCompanyAdmin } = require('../middleware/auth');

const router = express.Router();

// Force attachment for executable/markup types to prevent stored XSS —
// an uploaded HTML or SVG file rendered inline would run in the admin's session.
const FORCE_ATTACHMENT = /^(text\/html|text\/javascript|application\/javascript|image\/svg\+xml|application\/xhtml\+xml)/i;

// Drive file ids and Railway "rw_<uuid>" ids — nothing else is a valid id.
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,80}$/;

function setFileHeaders(res, { mimeType, name, mode }) {
  const safeName = (name || 'file').replace(/[^\w.\-]/g, '_');
  const disposition = (mode === 'download' || FORCE_ATTACHMENT.test(mimeType || '')) ? 'attachment' : 'inline';
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Student documents must never sit in a shared or browser cache.
  res.setHeader('Cache-Control', 'private, no-store');
}

// Every open is recorded — except the small profile photo staff see in the
// student list, which loads for every row on every visit and would bury
// the real activity. Bankers are always recorded.
function auditOpen(req, { studentKey, name, mode }) {
  if (req.query.purpose === 'thumbnail' && req.admin.role !== 'banker') return;
  logAudit({
    actor: req.admin.name, role: req.admin.role,
    action: mode === 'download' ? 'document.download' : 'document.view',
    target: studentKey || '', details: { file: name },
  });
}

// A Drive file is served only if it sits inside a student folder the caller
// may see — never an arbitrary Drive id (admins.json, audit logs…).
async function driveFileStudent(req, fileId) {
  if (!(await includesOwner())) return null; // Drive students are Flyurdream's
  const folderKey = await findStudentFolderKeyForFile(fileId);
  if (!folderKey || !(await findFolderByName(ROOT_FOLDER_ID(), folderKey))) return null;
  const ref = await resolveStudent(folderKey);
  return ref && (await canSeeStudent(req.admin, ref)) ? ref : null;
}

async function serveRailwayFile(req, res, fileId, mode) {
  // getDocument only finds documents inside the caller's companies.
  const found = await getDocument(fileId);
  if (!found || !(await canSeeStudent(req.admin, found.ref))) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  const file = await readDocumentBytes(fileId);
  if (!file) return res.status(404).json({ success: false, error: 'File not found' });
  auditOpen(req, { studentKey: found.ref.key, name: file.name, mode });
  setFileHeaders(res, { mimeType: file.mimeType, name: file.name, mode });
  res.setHeader('Content-Length', file.buffer.length);
  res.end(file.buffer);
}

async function serveDriveFile(req, res, fileId, mode) {
  const ref = await driveFileStudent(req, fileId);
  if (!ref) return res.status(404).json({ success: false, error: 'File not found' });
  const folderKey = ref.key;

  const { stream, mimeType, name } = await getFileContentStream(fileId);
  auditOpen(req, { studentKey: folderKey, name, mode });
  setFileHeaders(res, { mimeType, name, mode });
  stream.on('error', () => res.status(500).end());
  stream.pipe(res);
}

// ── Bundles: several documents, from any students, as one zip ──────────
// Superadmin and company admins (the Document Management library; each
// file is checked against the caller's companies when the zip is built).
// The browser picks
// the files and the folder layout inside the zip; the list is held here
// for the life of the one-time link, so the link itself stays short.
const MAX_BUNDLE_FILES = 500;
const bundles = new Map(); // id -> { files, label, expires }

function sweepBundles() {
  const now = Date.now();
  for (const [id, b] of bundles) if (b.expires < now) bundles.delete(id);
}

// "Passport/Arshad (DL-1234-ABCD) - passport.pdf" → safe relative path
function safeZipPath(path) {
  const parts = String(path || '')
    .split(/[\\/]+/)
    .map((p) => p.replace(/[^\w .()\-]/g, '_').replace(/^\.+/, '').trim().slice(0, 120))
    .filter(Boolean);
  return parts.length ? parts.slice(-3).join('/') : null;
}

// POST /api/files/zip-link  { files: [{ id, path }], label }
router.post('/zip-link', verifyJWT, requireCompanyAdmin, (req, res) => {
  const list = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!list.length) return res.status(400).json({ success: false, error: 'No files selected' });
  if (list.length > MAX_BUNDLE_FILES) {
    return res.status(400).json({ success: false, error: `Select at most ${MAX_BUNDLE_FILES} files per download` });
  }
  const files = [];
  for (const f of list) {
    if (!FILE_ID_RE.test(String(f?.id || ''))) return res.status(400).json({ success: false, error: 'Invalid file id' });
    files.push({ id: f.id, path: safeZipPath(f.path) || f.id });
  }
  sweepBundles();
  const id = crypto.randomUUID();
  const label = String(req.body?.label || 'DocLocker_documents').replace(/[^\w\-]/g, '_').slice(0, 60) || 'DocLocker_documents';
  bundles.set(id, { files, label, expires: Date.now() + TTL_SECONDS * 1000 });
  const ticket = issueTicket({ kind: 'bundle', target: id, admin: req.admin });
  res.json({ success: true, url: `/api/files/zip/${id}?ticket=${encodeURIComponent(ticket)}` });
});

// GET /api/files/zip/:bundleId?ticket= — streams the zip built above.
router.get('/zip/:bundleId', verifyJWTOrTicket('bundle', (req) => req.params.bundleId), async (req, res) => {
  try {
    if (!['superadmin', 'admin'].includes(req.admin.role)) return res.status(403).json({ success: false, error: 'Admin access required' });
    sweepBundles();
    const bundle = bundles.get(req.params.bundleId);
    if (!bundle) return res.status(404).json({ success: false, error: 'This download has expired. Start it again from DocLocker.' });
    bundles.delete(req.params.bundleId);

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'document.download_bundle',
      target: bundle.label, details: { files: bundle.files.length },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.label}.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      console.error('bundle zip error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);

    // One unreadable file is skipped rather than failing the whole zip.
    const taken = new Set();
    for (const f of bundle.files) {
      try {
        // readDocumentBytes is scoped to the caller's companies; Drive ids
        // must belong to a student folder they may see.
        const buffer = isRailwayFileId(f.id)
          ? (await readDocumentBytes(f.id))?.buffer
          : (await driveFileStudent(req, f.id)) && (await readFileBuffer(f.id));
        if (!buffer) continue;
        let name = f.path;
        for (let n = 2; taken.has(name); n++) name = f.path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
        taken.add(name);
        archive.append(buffer, { name });
      } catch (fileErr) {
        console.warn(`bundle zip: skipping ${f.id} — ${fileErr.message}`);
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('bundle zip error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/files/:fileId/download-link
// Returns a one-time link (valid 2 minutes, this file only) for a browser
// download. Access is checked when the link is used, not here, so a link
// can never outlive a revoked grant.
router.post('/:fileId/download-link', verifyJWT, (req, res) => {
  const { fileId } = req.params;
  if (!FILE_ID_RE.test(fileId)) return res.status(400).json({ success: false, error: 'Invalid file id' });
  const ticket = issueTicket({ kind: 'file', target: fileId, admin: req.admin });
  res.json({ success: true, url: `/api/files/${encodeURIComponent(fileId)}/content?mode=download&ticket=${encodeURIComponent(ticket)}` });
});

// GET /api/files/:fileId/content?mode=view|download
// In the app: fetched with the Authorization header and shown in the
// document viewer. As a browser download: ?ticket= from the endpoint above
// (a ticket always downloads; it never renders inline).
// Railway documents have "rw_" ids; anything else is Drive.
router.get('/:fileId/content', verifyJWTOrTicket('file', (req) => req.params.fileId), async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!FILE_ID_RE.test(fileId)) return res.status(400).json({ success: false, error: 'Invalid file id' });
    const mode = req.viaTicket || req.query.mode === 'download' ? 'download' : 'view';

    if (isRailwayFileId(fileId)) return await serveRailwayFile(req, res, fileId, mode);
    return await serveDriveFile(req, res, fileId, mode);
  } catch (err) {
    console.error('fileProxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
