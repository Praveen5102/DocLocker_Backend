const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { sanitize, buildFolderKey } = require('../services/drive');
const { getAuthAccount } = require('../services/accounts');
const { runWithScope } = require('../services/tenantScope');
const { requireApplicant } = require('../middleware/auth');
const { logAudit } = require('../services/auditLog');
const {
  readDocument, summarizeResult, toLegacyParsed, ReaderError, READER_MIME_TYPES,
} = require('../services/documentReader');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

// Staff filling a student's portal send their JWT; lenders never upload.
// Returns the signed-in staff account, or null (then it's a student).
async function staffFromRequest(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  let claims;
  try {
    claims = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return null;
  }
  if (!claims.sub || claims.setup) return null;
  const account = await getAuthAccount(claims.sub).catch(() => null);
  if (!account || account.tokenVersion !== claims.tv || account.status !== 'active' || account.role === 'banker') return null;
  return account;
}

// Staff run in their own company scope; students need their PIN session.
function withCallerScope(req, res, next) {
  staffFromRequest(req).then((staff) => {
    req.staff = staff;
    if (!staff) return requireApplicant(req, res, next);
    const scope = staff.role === 'superadmin' ? { orgIds: null, homeOrgId: staff.orgId } : { orgIds: [staff.orgId], homeOrgId: staff.orgId };
    req.tenantScope = scope;
    runWithScope(scope, next);
  }).catch(next);
}

// POST /api/student-extract
// Body (multipart/form-data): docType, files (1-4), studentName,
// studentIdentifier, subFolder, sourceFile.
// Reads an already-uploaded ID/certificate with our own model and returns
// structured fields for auto-fill and identity checks. Students need their
// PIN session, the same as /api/student-upload, so this can't be used
// anonymously.
// Aadhaar is always read without consent, i.e. the number comes back masked.
router.post('/', upload.array('files', 4), withCallerScope, async (req, res) => {
  try {
    const { docType, studentName, studentIdentifier, subFolder = '', sourceFile = '' } = req.body;
    const files = req.files || [];

    const staff = req.staff;

    const unsupported = files.find((f) => !READER_MIME_TYPES.has(f.mimetype));
    if (unsupported) {
      return res.status(400).json({ success: false, error: `Unsupported file type for reading: ${unsupported.originalname}` });
    }

    const data = await readDocument(docType, files);
    const extraction = summarizeResult(docType, data);
    const parsedData = toLegacyParsed(docType, extraction.flat, { subFolder, sourceFile });

    logAudit({
      actor: staff ? staff.name : sanitize(req.studentRef.key.split('__')[0]),
      role: staff ? staff.role : 'student',
      action: 'document.extract',
      target: staff
        ? (studentName ? sanitize(buildFolderKey((studentName || '').trim(), (studentIdentifier || '').trim())) : '')
        : req.studentRef.key,
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
