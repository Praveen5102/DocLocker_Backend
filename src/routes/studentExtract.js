const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { sanitize, buildFolderKey } = require('../services/drive');
const { resolveStudent } = require('../services/studentStore');
const { logAudit } = require('../services/auditLog');
const {
  readDocument, summarizeResult, toLegacyParsed, ReaderError, READER_MIME_TYPES,
} = require('../services/documentReader');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

// Staff (superadmin/advisor) filling a student's portal send their JWT;
// bankers never upload. Returns the admin payload, or null if absent/invalid.
function staffFromRequest(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const admin = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    return admin.role === 'banker' ? null : admin;
  } catch {
    return null;
  }
}

// POST /api/student-extract
// Body (multipart/form-data): docType, files (1-4), studentName,
// studentIdentifier, subFolder, sourceFile.
// Reads an already-uploaded ID/certificate with our own model and returns
// structured fields for auto-fill and identity checks. Students are
// validated the same way as /api/student-upload (name + identifier, the
// student must already exist), so this can't be used anonymously.
// Aadhaar is always read without consent, i.e. the number comes back masked.
router.post('/', upload.array('files', 4), async (req, res) => {
  try {
    const { docType, studentName, studentIdentifier, subFolder = '', sourceFile = '' } = req.body;
    const files = req.files || [];

    const staff = staffFromRequest(req);
    if (!staff) {
      if (!studentName || !studentName.trim()) {
        return res.status(400).json({ success: false, error: 'Missing studentName' });
      }
      if (!studentIdentifier || studentIdentifier.trim().length < 5) {
        return res.status(400).json({ success: false, error: 'Missing or invalid identifier' });
      }
      const folderKey = buildFolderKey(sanitize(studentName.trim()), studentIdentifier.trim());
      if (!(await resolveStudent(folderKey))) {
        return res.status(404).json({ success: false, error: 'Student not found. Please complete registration first.' });
      }
    }

    const unsupported = files.find((f) => !READER_MIME_TYPES.has(f.mimetype));
    if (unsupported) {
      return res.status(400).json({ success: false, error: `Unsupported file type for reading: ${unsupported.originalname}` });
    }

    const data = await readDocument(docType, files);
    const extraction = summarizeResult(docType, data);
    const parsedData = toLegacyParsed(docType, extraction.flat, { subFolder, sourceFile });

    logAudit({
      actor: staff ? staff.name : sanitize((studentName || '').trim()),
      role: staff ? staff.role : 'student',
      action: 'document.extract',
      target: studentName ? sanitize(buildFolderKey((studentName || '').trim(), (studentIdentifier || '').trim())) : '',
      details: { docType, fileCount: files.length, review: extraction.review.status, seconds: extraction.seconds },
    });

    res.json({ success: true, extraction, parsedData });
  } catch (err) {
    if (err instanceof ReaderError) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    console.error('student-extract error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
