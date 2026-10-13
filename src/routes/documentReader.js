const express = require('express');
const multer = require('multer');
const { verifyJWT, requireStaff } = require('../middleware/auth');
const { logAudit } = require('../services/auditLog');
const { readDocument, ReaderError } = require('../services/documentReader');

const router = express.Router();

// Memory storage — files are forwarded straight through to the reader and
// never touch our own Drive storage, so there's nothing to clean up.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

// POST /api/document-reader/extract — staff only (superadmin/advisor).
// Body (multipart/form-data): doc_type, files (1-4), consent (aadhaar only).
// Standalone verification tool: nothing is saved to Drive or attached to a
// student record.
router.post('/extract', verifyJWT, requireStaff, upload.array('files', 4), async (req, res) => {
  try {
    const docType = req.body.doc_type;
    const files = req.files || [];
    const data = await readDocument(docType, files, { consent: req.body.consent === 'yes' });

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'document_reader.extract',
      target: docType, details: { fileCount: files.length, seconds: data?.seconds ?? null },
    });

    res.json({ success: true, result: data });
  } catch (err) {
    if (err instanceof ReaderError) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    console.error('documentReader extract error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
