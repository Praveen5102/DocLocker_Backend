const express = require('express');
const {
  ROOT_FOLDER_ID, findFolderByName, findStudentFolderKeyForFile, getFileContentStream,
} = require('../services/drive');
const { readStudentMeta } = require('../services/studentMeta');
const { verifyJWTFlexible } = require('../middleware/auth');

const router = express.Router();

// GET /api/files/:fileId/content?mode=view|download&token=...
// Streams a file's bytes directly from Drive through our own backend, so
// nothing ever needs to be made publicly accessible — access is gated by
// the caller's JWT plus (for bankers) an explicit access grant on the
// specific student the file belongs to.
router.get('/:fileId/content', verifyJWTFlexible, async (req, res) => {
  try {
    const { fileId } = req.params;
    const mode = req.query.mode === 'download' ? 'download' : 'view';

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
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${mode === 'download' ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`);
    stream.on('error', () => res.status(500).end());
    stream.pipe(res);
  } catch (err) {
    console.error('fileProxy error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
