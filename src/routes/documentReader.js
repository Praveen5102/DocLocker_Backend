const express = require('express');
const multer = require('multer');
const { verifyJWT, requireStaff } = require('../middleware/auth');
const { logAudit } = require('../services/auditLog');

const router = express.Router();

// Memory storage — files are forwarded straight through to the external
// reader and never touch our own Drive storage, so there's nothing to clean
// up either way.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

const READER_BASE_URL = 'https://certificate-reader-production.up.railway.app';

const MAX_FILES = { certificate: 1, passport: 4, aadhaar: 4, pan: 4 };

// POST /api/document-reader/extract — staff only (superadmin/advisor).
// Body (multipart/form-data): doc_type, files (1-4), consent (aadhaar only).
// Pure proxy: forwards to the external OCR/extraction service and hands its
// JSON straight back. Nothing here is saved to Drive or attached to any
// student record — this is a standalone verification tool.
router.post('/extract', verifyJWT, requireStaff, upload.array('files', 4), async (req, res) => {
  try {
    const docType = req.body.doc_type;
    if (!MAX_FILES[docType]) {
      return res.status(400).json({ success: false, error: `Invalid doc_type. Must be one of: ${Object.keys(MAX_FILES).join(', ')}` });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one file is required' });
    }
    const max = MAX_FILES[docType];
    if (files.length > max) {
      return res.status(400).json({ success: false, error: `${docType} accepts at most ${max} file${max === 1 ? '' : 's'}` });
    }

    const form = new FormData();
    form.append('doc_type', docType);
    if (docType === 'aadhaar' && req.body.consent === 'yes') form.append('consent', 'yes');
    for (const f of files) {
      form.append('files', new Blob([f.buffer], { type: f.mimetype || 'application/octet-stream' }), f.originalname);
    }

    let upstream;
    try {
      upstream = await fetch(`${READER_BASE_URL}/api/extract`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      console.error('documentReader upstream error:', err.message);
      return res.status(timedOut ? 504 : 502).json({
        success: false,
        error: timedOut ? 'Document reader timed out. Try again.' : 'Could not reach the document reader service.',
      });
    }

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, error: data?.detail || 'Document reader service error' });
    }

    // Fire-and-forget — a verification tool being used is worth a trail, but
    // must never block or fail the response to the person using it.
    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'document_reader.extract',
      target: docType, details: { fileCount: files.length, seconds: data?.seconds ?? null },
    });

    res.json({ success: true, result: data });
  } catch (err) {
    console.error('documentReader extract error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
