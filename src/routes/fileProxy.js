const express = require('express');
const {
  ROOT_FOLDER_ID, findFolderByName, findStudentFolderKeyForFile, getFileContentStream,
} = require('../services/drive');
const { readStudentMeta } = require('../services/studentMeta');
const { isRailwayFileId, getDocument, readDocumentBytes, readMeta } = require('../services/studentStore');
const { verifyJWTFlexible } = require('../middleware/auth');

const router = express.Router();

// Force attachment for executable/markup types to prevent stored XSS —
// an uploaded HTML or SVG file rendered inline would run in the admin's session.
const FORCE_ATTACHMENT = /^(text\/html|text\/javascript|application\/javascript|image\/svg\+xml|application\/xhtml\+xml)/i;

function setFileHeaders(res, { mimeType, name, mode }) {
  const safeName = (name || 'file').replace(/[^\w.\-]/g, '_');
  const disposition = (mode === 'download' || FORCE_ATTACHMENT.test(mimeType || '')) ? 'attachment' : 'inline';
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Student documents must never sit in a shared or browser cache.
  res.setHeader('Cache-Control', 'private, no-store');
}

// Railway documents: decrypted in memory and sent; never stored in plaintext.
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
  setFileHeaders(res, { mimeType: file.mimeType, name: file.name, mode });
  res.setHeader('Content-Length', file.buffer.length);
  res.end(file.buffer);
}

// GET /api/files/:fileId/content?mode=view|download&token=...
// Streams a file's bytes through our own backend, so nothing ever needs to
// be made publicly accessible — access is gated by the caller's JWT plus
// (for bankers) an explicit access grant on the specific student the file
// belongs to. Railway documents have "rw_" ids; anything else is Drive.
router.get('/:fileId/content', verifyJWTFlexible, async (req, res) => {
  try {
    const { fileId } = req.params;
    const mode = req.query.mode === 'download' ? 'download' : 'view';

    if (isRailwayFileId(fileId)) return await serveRailwayFile(req, res, fileId, mode);

    if (req.admin.role === 'banker') {
      const folderKey = await findStudentFolderKeyForFile(fileId);
      if (!folderKey) return res.status(404).json({ success: false, error: 'File not found' });

      const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
      if (!stuDir) return res.status(404).json({ success: false, error: 'File not found' });

      const { meta } = await readStudentMeta(stuDir.id);
      const shared = new Set(meta.sharedBankers || []);
      if (!shared.has(req.admin.name)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }
    }

    const { stream, mimeType, name } = await getFileContentStream(fileId);
    setFileHeaders(res, { mimeType, name, mode });
    stream.on('error', () => res.status(500).end());
    stream.pipe(res);
  } catch (err) {
    console.error('fileProxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
