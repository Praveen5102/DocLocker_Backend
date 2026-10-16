const express = require('express');
const {
  ROOT_FOLDER_ID, findFolderByName, findStudentFolderKeyForFile, getFileContentStream,
} = require('../services/drive');
const { readStudentMeta } = require('../services/studentMeta');
const { isRailwayFileId, getDocument, readDocumentBytes, readMeta } = require('../services/studentStore');
const { issueTicket } = require('../services/fileTickets');
const { logAudit } = require('../services/auditLog');
const { verifyJWT, verifyJWTOrTicket } = require('../middleware/auth');

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

async function serveRailwayFile(req, res, fileId, mode) {
  const found = await getDocument(fileId);
  if (!found) return res.status(404).json({ success: false, error: 'File not found' });

  if (req.admin.role === 'banker') {
    const meta = await readMeta(found.ref);
    if (!new Set(meta.sharedBankers || []).has(req.admin.name)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
  }

  const file = await readDocumentBytes(fileId);
  if (!file) return res.status(404).json({ success: false, error: 'File not found' });
  auditOpen(req, { studentKey: found.ref.key, name: file.name, mode });
  setFileHeaders(res, { mimeType: file.mimeType, name: file.name, mode });
  res.setHeader('Content-Length', file.buffer.length);
  res.end(file.buffer);
}

async function serveDriveFile(req, res, fileId, mode) {
  const isThumbnail = req.query.purpose === 'thumbnail' && req.admin.role !== 'banker';

  // Which student this file belongs to — needed for the banker check and
  // for the audit entry (skipped for staff thumbnails, which are neither).
  let folderKey = null;
  if (req.admin.role === 'banker' || !isThumbnail) {
    folderKey = await findStudentFolderKeyForFile(fileId);
  }

  if (req.admin.role === 'banker') {
    if (!folderKey) return res.status(404).json({ success: false, error: 'File not found' });
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) return res.status(404).json({ success: false, error: 'File not found' });
    const { meta } = await readStudentMeta(stuDir.id);
    if (!new Set(meta.sharedBankers || []).has(req.admin.name)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
  }

  const { stream, mimeType, name } = await getFileContentStream(fileId);
  auditOpen(req, { studentKey: folderKey, name, mode });
  setFileHeaders(res, { mimeType, name, mode });
  stream.on('error', () => res.status(500).end());
  stream.pipe(res);
}

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
