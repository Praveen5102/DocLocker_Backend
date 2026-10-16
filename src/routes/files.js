const express = require('express');
const multer  = require('multer');
const {
  sanitize, buildFolderKey, cleanFolderKey, folderKeyDisplayName,
  getOrCreate, trashFilesByNameExcept, uploadBuffer,
} = require('../services/drive');
const { convertToPdf, convertHtmlToPdf } = require('../services/pdf');
const { parseDocument }                  = require('../services/documentParser');
const { buildEligibilityHtml }           = require('../services/eligibilityReport');
const {
  resolveStudent, resolveOrCreateStudent, writeMeta, storeDocument,
} = require('../services/studentStore');
const { studentsCache }                  = require('../services/cache');
const { verifyJWT, requireStaff }        = require('../middleware/auth');
const { logAudit }                       = require('../services/auditLog');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Canonical audit target for a student — matches bankerAccess.js's own
// sanitize(buildFolderKey(...)) exactly, computed fresh from the raw name/
// identifier every time (never reused from a route's own pre-sanitized
// folderKey variable, which can legally differ char-for-char — e.g. an
// email identifier's "@" survives buildFolderKey's own filter but not this
// outer sanitize()) so every audit entry's target lines up with the Admin
// dashboard's own reconstruction of it from student.name/email/phone.
function auditTargetFor(studentName, studentIdentifier) {
  return sanitize(buildFolderKey((studentName || '').trim(), (studentIdentifier || '').trim()));
}

// Saves an uploaded (and already converted) document for either kind of
// student. Railway students get an encrypted bucket copy; Drive students
// keep the old flow. Either way the new copy is saved FIRST and only then
// are older versions retired — a failure in between never leaves the
// student without the document.
async function saveUpload(ref, { subFolder, fileName, file, converted, uploadedBy }) {
  const section = sanitize(subFolder);
  const cleanNameNoExt = fileName.replace(/\.[^/.]+$/, '');
  const { pdfBuffer, extractedText } = converted;

  const finalBuffer   = pdfBuffer || file.buffer;
  const finalMimeType = pdfBuffer ? 'application/pdf' : file.mimetype;
  const finalFileName = pdfBuffer ? (cleanNameNoExt + '.pdf') : fileName;

  let uploaded;
  if (ref.kind === 'railway') {
    const saved = await storeDocument(ref, {
      section, fileName: finalFileName, mimeType: finalMimeType, buffer: finalBuffer,
      uploadedBy, replaces: [fileName, cleanNameNoExt + '.pdf'],
    });
    uploaded = { id: saved.id, name: saved.name, webViewLink: null };
  } else {
    const subDir = await getOrCreate(ref.dir.id, section);
    uploaded = await uploadBuffer(subDir.id, finalFileName, finalMimeType, finalBuffer);
    await Promise.all([
      trashFilesByNameExcept(subDir.id, fileName, uploaded.id),
      trashFilesByNameExcept(subDir.id, cleanNameNoExt + '.pdf', uploaded.id),
    ]);
  }

  let parsedData = null;
  if (extractedText) {
    const parsed = parseDocument({ subFolder: section, sourceFile: finalFileName, extractedText });
    parsedData = { type: parsed.type, subFolder: section, sourceFile: finalFileName, fields: parsed.fields };
  }

  return { fileId: uploaded.id, webViewLink: uploaded.webViewLink || null, fileName: uploaded.name, parsedData };
}

// Saves one auto-generated report (Student_Summary.pdf / Eligibility_Report.pdf)
// into the student's "Others" section, replacing the previous copy.
async function saveGeneratedPdf(ref, fileName, buffer, uploadedBy) {
  if (ref.kind === 'railway') {
    const saved = await storeDocument(ref, {
      section: 'Others', fileName, mimeType: 'application/pdf', buffer, uploadedBy,
    });
    return { id: saved.id, webViewLink: null };
  }
  const othersDir = await getOrCreate(ref.dir.id, 'Others');
  const uploaded = await uploadBuffer(othersDir.id, fileName, 'application/pdf', buffer);
  await Promise.all([
    trashFilesByNameExcept(ref.dir.id,   fileName, uploaded.id),
    trashFilesByNameExcept(othersDir.id, fileName, uploaded.id),
  ]);
  return uploaded;
}

// Summary + (optional) eligibility report; the eligibility report is
// best-effort and never fails the summary save.
async function saveReports(ref, summaryBuf, eligBuf, uploadedBy) {
  const [summaryUploaded, eligUpload] = await Promise.all([
    saveGeneratedPdf(ref, 'Student_Summary.pdf', summaryBuf, uploadedBy),
    eligBuf
      ? saveGeneratedPdf(ref, 'Eligibility_Report.pdf', eligBuf, uploadedBy)
          .catch((e) => { console.error('Eligibility upload failed:', e.message); return null; })
      : Promise.resolve(null),
  ]);
  return {
    success: true,
    fileId: summaryUploaded.id,
    webViewLink: summaryUploaded.webViewLink || null,
    ...(eligUpload && { eligibilityReport: { fileId: eligUpload.id, webViewLink: eligUpload.webViewLink || null } }),
  };
}

// POST /api/upload
// Returns parsedData in response — frontend holds this, no JSON saved
router.post('/upload', verifyJWT, requireStaff, upload.single('file'), async (req, res) => {
  try {
    const { studentName, subFolder, fileName } = req.body;
    const skipOcr = req.body.skipOcr === '1';
    const file = req.file;
    if (!studentName || !subFolder || !fileName || !file) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const cleanNameNoExt = fileName.replace(/\.[^/.]+$/, '');

    // Student lookup and PDF conversion are independent — run them together.
    const [ref, converted] = await Promise.all([
      resolveOrCreateStudent(cleanFolderKey(studentName)),
      convertToPdf(file.buffer, file.mimetype, cleanNameNoExt, { skipOcr }),
    ]);

    const result = await saveUpload(ref, { subFolder, fileName, file, converted, uploadedBy: req.admin.name });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/meta
router.post('/meta', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName, metaJson } = req.body;
    if (!studentName || !metaJson) return res.status(400).json({ success: false, error: 'Missing studentName or metaJson' });

    let metaObj;
    try { metaObj = JSON.parse(metaJson); }
    catch { return res.status(400).json({ success: false, error: 'Invalid JSON in metaJson' }); }

    const ref  = await resolveOrCreateStudent(cleanFolderKey(studentName));
    const file = await writeMeta(ref, metaObj);

    studentsCache.clear();
    res.json({ success: true, ...(file && file.id && { fileId: file.id }) });
  } catch (err) {
    console.error('saveMeta error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/summary
// Body: { studentName, htmlContent, documents: [...parsedData] }
// documents = array of parsedData objects collected by frontend from upload responses
router.post('/summary', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName, htmlContent, documents = [] } = req.body;
    if (!studentName || !htmlContent) return res.status(400).json({ success: false, error: 'Missing studentName or htmlContent' });

    const dispName = folderKeyDisplayName(studentName);
    const ref      = await resolveOrCreateStudent(cleanFolderKey(studentName));

    let eligHtml = null;
    try { eligHtml = buildEligibilityHtml(dispName, documents); }
    catch (e) { console.error('Eligibility HTML build failed:', e.message); }

    // Convert both PDFs concurrently — nothing is saved yet, nothing to lose.
    const [summaryBuf, eligBuf] = await Promise.all([
      convertHtmlToPdf(htmlContent, dispName),
      eligHtml
        ? convertHtmlToPdf(eligHtml, dispName + '_Elig')
            .catch((e) => { console.error('Eligibility PDF convert failed:', e.message); return null; })
        : Promise.resolve(null),
    ]);

    res.json(await saveReports(ref, summaryBuf, eligBuf, req.admin.name));
  } catch (err) {
    console.error('saveSummaryPdf error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/eligibility-report — standalone regeneration
// Body: { studentName, documents: [...parsedData] }
router.post('/eligibility-report', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName, documents = [] } = req.body;
    if (!studentName) return res.status(400).json({ success: false, error: 'Missing studentName' });

    const dispName = folderKeyDisplayName(studentName);
    const ref      = await resolveOrCreateStudent(cleanFolderKey(studentName));
    const html     = buildEligibilityHtml(dispName, documents);
    const pdfBuf   = await convertHtmlToPdf(html, dispName + '_Elig');

    const uploaded = await saveGeneratedPdf(ref, 'Eligibility_Report.pdf', pdfBuf, req.admin.name);
    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink || null });
  } catch (err) {
    console.error('eligibilityReport error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Student self-service upload (no JWT — validated by name + identifier) ─────
// Security: the student must ALREADY EXIST (created via /api/student-meta
// during registration). resolveStudent never creates anything, which
// prevents unauthenticated callers from creating arbitrary students.
router.post('/student-upload', upload.single('file'), async (req, res) => {
  try {
    const { studentName, studentIdentifier, subFolder, fileName } = req.body;
    const file = req.file;

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing studentName' });
    }
    if (!studentIdentifier || studentIdentifier.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Missing or invalid identifier' });
    }
    if (!subFolder || !fileName || !file) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const folderKey = buildFolderKey(sanitize(studentName.trim()), studentIdentifier.trim());
    const cleanNameNoExt = fileName.replace(/\.[^/.]+$/, '');
    const skipOcr = req.body.skipOcr === '1';

    const [ref, converted] = await Promise.all([
      resolveStudent(folderKey),
      convertToPdf(file.buffer, file.mimetype, cleanNameNoExt, { skipOcr }),
    ]);

    if (!ref) {
      return res.status(404).json({ success: false, error: 'Student not found. Please complete registration first.' });
    }

    const result = await saveUpload(ref, {
      subFolder: subFolder.trim(), fileName, file, converted, uploadedBy: sanitize(studentName.trim()),
    });

    logAudit({
      actor: sanitize(studentName.trim()), role: 'student', action: 'document.upload',
      target: auditTargetFor(studentName, studentIdentifier), details: { subFolder: sanitize(subFolder), fileName: result.fileName },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('student-upload error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/student-summary — student self-service summary + eligibility PDF (no JWT)
// Mirrors staff /api/summary but validated by name + identifier, same as
// student-upload/student-meta. This is the ONLY caller in practice — the
// student portal generates its own summary PDF on every save — so it must
// not require a staff JWT the student never has.
//
// The summary PDF itself now arrives pre-rendered as a real file (multipart
// field "summaryPdf") — summaryGenerator.js builds it client-side with
// html2canvas + jsPDF so it can use real CSS (grid/flexbox/gradients/custom
// properties), none of which survive the convertHtmlToPdf() pipeline below
// (a Google Docs HTML import, not a browser engine). The eligibility report
// alongside it is unaffected — it's simple enough to stay on that pipeline.
// Body (multipart/form-data): studentName, studentIdentifier,
// documents (JSON-encoded [...parsedData]), summaryPdf (file)
router.post('/student-summary', upload.single('summaryPdf'), async (req, res) => {
  try {
    const { studentName, studentIdentifier } = req.body;
    let documents = [];
    try { documents = req.body.documents ? JSON.parse(req.body.documents) : []; }
    catch (_) { documents = []; }

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing studentName' });
    }
    if (!studentIdentifier || studentIdentifier.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Missing or invalid identifier' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Missing summaryPdf' });
    }

    const dispName  = sanitize(studentName.trim());
    const folderKey = buildFolderKey(dispName, studentIdentifier.trim());

    // The student should already exist (meta save runs first), but create
    // defensively so a summary save never fails on that alone.
    const ref = await resolveOrCreateStudent(folderKey);

    let eligHtml = null;
    try { eligHtml = buildEligibilityHtml(dispName, documents); }
    catch (e) { console.error('Eligibility HTML build failed:', e.message); }

    const eligBuf = eligHtml
      ? await convertHtmlToPdf(eligHtml, dispName + '_Elig')
          .catch((e) => { console.error('Eligibility PDF convert failed:', e.message); return null; })
      : null;

    const response = await saveReports(ref, req.file.buffer, eligBuf, dispName);

    logAudit({
      actor: dispName, role: 'student', action: 'summary.generate',
      target: auditTargetFor(studentName, studentIdentifier), details: null,
    });

    res.json(response);
  } catch (err) {
    console.error('student-summary error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/student-meta — student self-service meta save (no JWT)
// Creates the student on first save: on Railway for brand-new students,
// in Drive only if Railway storage isn't configured. A student who already
// has a Drive folder keeps being saved there.
router.post('/student-meta', async (req, res) => {
  try {
    const { studentName, studentIdentifier, metaJson } = req.body;

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing studentName' });
    }
    if (!studentIdentifier || studentIdentifier.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Missing or invalid identifier' });
    }
    if (!metaJson) {
      return res.status(400).json({ success: false, error: 'Missing metaJson' });
    }

    let metaObj;
    try { metaObj = JSON.parse(metaJson); }
    catch { return res.status(400).json({ success: false, error: 'Invalid JSON in metaJson' }); }

    const folderKey = buildFolderKey(sanitize(studentName.trim()), studentIdentifier.trim());
    const ref = await resolveOrCreateStudent(folderKey);
    await writeMeta(ref, metaObj);

    studentsCache.clear();
    logAudit({
      actor: sanitize(studentName.trim()), role: 'student', action: 'student.save',
      target: auditTargetFor(studentName, studentIdentifier), details: { storage: ref.kind },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('student-meta error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
