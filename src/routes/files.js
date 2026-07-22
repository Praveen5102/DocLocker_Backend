const express = require('express');
const multer  = require('multer');
const {
  ROOT_FOLDER_ID, sanitize, buildFolderKey, cleanFolderKey, folderKeyDisplayName,
  getOrCreate, findFolderByName, trashFilesByName, uploadBuffer, createJsonFile,
} = require('../services/drive');
const { convertToPdf, convertHtmlToPdf } = require('../services/pdf');
const { parseDocument }                  = require('../services/documentParser');
const { buildEligibilityHtml }           = require('../services/eligibilityReport');
const { studentsCache }                  = require('../services/cache');
const { verifyJWT, requireStaff }        = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/upload
// Returns parsedData in response — frontend holds this, no JSON saved to Drive
router.post('/upload', verifyJWT, requireStaff, upload.single('file'), async (req, res) => {
  try {
    const { studentName, subFolder, fileName } = req.body;
    const file = req.file;
    if (!studentName || !subFolder || !fileName || !file) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const cleanNameNoExt = fileName.replace(/\.[^/.]+$/, '');

    // Run folder chain creation and PDF conversion concurrently — independent of each other
    const [subDir, { pdfBuffer, extractedText }] = await Promise.all([
      (async () => {
        const stuDir = await getOrCreate(ROOT_FOLDER_ID(), cleanFolderKey(studentName));
        return getOrCreate(stuDir.id, sanitize(subFolder));
      })(),
      convertToPdf(file.buffer, file.mimetype, cleanNameNoExt),
    ]);

    // Trash old versions while we prepare final file details
    await Promise.all([
      trashFilesByName(subDir.id, fileName),
      trashFilesByName(subDir.id, cleanNameNoExt + '.pdf'),
    ]);

    let finalBuffer   = pdfBuffer || file.buffer;
    let finalMimeType = pdfBuffer ? 'application/pdf' : file.mimetype;
    let finalFileName = pdfBuffer ? (cleanNameNoExt + '.pdf') : fileName;

    const uploaded = await uploadBuffer(subDir.id, finalFileName, finalMimeType, finalBuffer);

    let parsedData = null;
    if (extractedText) {
      const parsed = parseDocument({ subFolder: sanitize(subFolder), sourceFile: finalFileName, extractedText });
      parsedData = { type: parsed.type, subFolder: sanitize(subFolder), sourceFile: finalFileName, fields: parsed.fields };
    }

    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink, fileName: uploaded.name, parsedData });
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

    const stuDir    = await getOrCreate(ROOT_FOLDER_ID(), cleanFolderKey(studentName));
    const othersDir = await getOrCreate(stuDir.id, 'Others');

    // Trash old copies (root-level legacy + Others/) in parallel before writing new one
    await Promise.all([
      trashFilesByName(stuDir.id,    'student_meta.json'),
      trashFilesByName(othersDir.id, 'student_meta.json'),
    ]);
    const file = await createJsonFile(othersDir.id, 'student_meta.json', metaObj);

    studentsCache.clear();
    res.json({ success: true, fileId: file.id });
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

    const dispName  = folderKeyDisplayName(studentName);
    const stuDir    = await getOrCreate(ROOT_FOLDER_ID(), cleanFolderKey(studentName));
    const othersDir = await getOrCreate(stuDir.id, 'Others');

    // Build eligibility HTML synchronously (no Drive I/O)
    let eligHtml = null;
    try { eligHtml = buildEligibilityHtml(dispName, documents); }
    catch (e) { console.error('Eligibility HTML build failed:', e.message); }

    // All trash operations + both PDF conversions in parallel.
    // Uploads happen after this Promise.all so every trash is done before any upload.
    const [summaryBuf, eligBuf] = await Promise.all([
      convertHtmlToPdf(htmlContent, dispName),
      eligHtml
        ? convertHtmlToPdf(eligHtml, dispName + '_Elig')
            .catch((e) => { console.error('Eligibility PDF convert failed:', e.message); return null; })
        : Promise.resolve(null),
      trashFilesByName(stuDir.id,    'Student_Summary.pdf'),
      trashFilesByName(othersDir.id, 'Student_Summary.pdf'),
      eligHtml ? trashFilesByName(stuDir.id,    'Eligibility_Report.pdf') : Promise.resolve(),
      eligHtml ? trashFilesByName(othersDir.id, 'Eligibility_Report.pdf') : Promise.resolve(),
    ]);

    // Upload both in parallel
    const [summaryUploaded, eligUpload] = await Promise.all([
      uploadBuffer(othersDir.id, 'Student_Summary.pdf', 'application/pdf', summaryBuf),
      eligBuf
        ? uploadBuffer(othersDir.id, 'Eligibility_Report.pdf', 'application/pdf', eligBuf)
            .catch((e) => { console.error('Eligibility upload failed:', e.message); return null; })
        : Promise.resolve(null),
    ]);

    const eligibilityReport = eligUpload
      ? { fileId: eligUpload.id, webViewLink: eligUpload.webViewLink }
      : null;

    res.json({
      success: true,
      fileId: summaryUploaded.id,
      webViewLink: summaryUploaded.webViewLink,
      ...(eligibilityReport && { eligibilityReport }),
    });
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

    const dispName  = folderKeyDisplayName(studentName);
    const stuDir    = await getOrCreate(ROOT_FOLDER_ID(), cleanFolderKey(studentName));
    const othersDir = await getOrCreate(stuDir.id, 'Others');
    const html      = buildEligibilityHtml(dispName, documents);

    // Trash old copies and convert in parallel
    const [pdfBuf] = await Promise.all([
      convertHtmlToPdf(html, dispName + '_Elig'),
      trashFilesByName(stuDir.id,    'Eligibility_Report.pdf'),
      trashFilesByName(othersDir.id, 'Eligibility_Report.pdf'),
    ]);
    const uploaded = await uploadBuffer(othersDir.id, 'Eligibility_Report.pdf', 'application/pdf', pdfBuf);

    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink });
  } catch (err) {
    console.error('eligibilityReport error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Student self-service upload (no JWT — validated by name + identifier) ─────
// Security: the student folder must ALREADY EXIST (created via /api/student-meta
// during registration). findFolderByName returns 404 if the folder doesn't exist,
// which prevents unauthenticated callers from creating arbitrary Drive folders.
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

    // Folder lookup + PDF conversion run concurrently.
    // findFolderByName returns null if the folder doesn't exist (student not registered yet).
    const [stuDir, { pdfBuffer, extractedText }] = await Promise.all([
      findFolderByName(ROOT_FOLDER_ID(), folderKey),
      convertToPdf(file.buffer, file.mimetype, cleanNameNoExt),
    ]);

    if (!stuDir) {
      return res.status(404).json({ success: false, error: 'Student not found. Please complete registration first.' });
    }

    const subDir = await getOrCreate(stuDir.id, sanitize(subFolder.trim()));

    await Promise.all([
      trashFilesByName(subDir.id, fileName),
      trashFilesByName(subDir.id, cleanNameNoExt + '.pdf'),
    ]);

    const finalBuffer   = pdfBuffer || file.buffer;
    const finalMimeType = pdfBuffer ? 'application/pdf' : file.mimetype;
    const finalFileName = pdfBuffer ? (cleanNameNoExt + '.pdf') : fileName;

    const uploaded = await uploadBuffer(subDir.id, finalFileName, finalMimeType, finalBuffer);

    let parsedData = null;
    if (extractedText) {
      const parsed = parseDocument({ subFolder: sanitize(subFolder), sourceFile: finalFileName, extractedText });
      parsedData = { type: parsed.type, subFolder: sanitize(subFolder), sourceFile: finalFileName, fields: parsed.fields };
    }

    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink, fileName: uploaded.name, parsedData });
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
// Body: { studentName, studentIdentifier, htmlContent, documents: [...parsedData] }
router.post('/student-summary', async (req, res) => {
  try {
    const { studentName, studentIdentifier, htmlContent, documents = [] } = req.body;

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({ success: false, error: 'Missing studentName' });
    }
    if (!studentIdentifier || studentIdentifier.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Missing or invalid identifier' });
    }
    if (!htmlContent) {
      return res.status(400).json({ success: false, error: 'Missing htmlContent' });
    }

    const dispName  = sanitize(studentName.trim());
    const folderKey = buildFolderKey(dispName, studentIdentifier.trim());

    // getOrCreate — folder should already exist (meta save runs first), but
    // create it defensively so a summary save never fails on that alone.
    const stuDir    = await getOrCreate(ROOT_FOLDER_ID(), folderKey);
    const othersDir = await getOrCreate(stuDir.id, 'Others');

    let eligHtml = null;
    try { eligHtml = buildEligibilityHtml(dispName, documents); }
    catch (e) { console.error('Eligibility HTML build failed:', e.message); }

    const [summaryBuf, eligBuf] = await Promise.all([
      convertHtmlToPdf(htmlContent, dispName),
      eligHtml
        ? convertHtmlToPdf(eligHtml, dispName + '_Elig')
            .catch((e) => { console.error('Eligibility PDF convert failed:', e.message); return null; })
        : Promise.resolve(null),
      trashFilesByName(stuDir.id,    'Student_Summary.pdf'),
      trashFilesByName(othersDir.id, 'Student_Summary.pdf'),
      eligHtml ? trashFilesByName(stuDir.id,    'Eligibility_Report.pdf') : Promise.resolve(),
      eligHtml ? trashFilesByName(othersDir.id, 'Eligibility_Report.pdf') : Promise.resolve(),
    ]);

    const [summaryUploaded, eligUpload] = await Promise.all([
      uploadBuffer(othersDir.id, 'Student_Summary.pdf', 'application/pdf', summaryBuf),
      eligBuf
        ? uploadBuffer(othersDir.id, 'Eligibility_Report.pdf', 'application/pdf', eligBuf)
            .catch((e) => { console.error('Eligibility upload failed:', e.message); return null; })
        : Promise.resolve(null),
    ]);

    const eligibilityReport = eligUpload
      ? { fileId: eligUpload.id, webViewLink: eligUpload.webViewLink }
      : null;

    res.json({
      success: true,
      fileId: summaryUploaded.id,
      webViewLink: summaryUploaded.webViewLink,
      ...(eligibilityReport && { eligibilityReport }),
    });
  } catch (err) {
    console.error('student-summary error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/student-meta — student self-service meta save (no JWT)
// Uses getOrCreate so it creates the folder for brand-new students too.
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

    // getOrCreate — creates the root student folder for first-time students
    const stuDir    = await getOrCreate(ROOT_FOLDER_ID(), folderKey);
    const othersDir = await getOrCreate(stuDir.id, 'Others');

    // Trash old copies in parallel before writing new one
    await Promise.all([
      trashFilesByName(stuDir.id,    'student_meta.json'),
      trashFilesByName(othersDir.id, 'student_meta.json'),
    ]);
    await createJsonFile(othersDir.id, 'student_meta.json', metaObj);

    studentsCache.clear();
    res.json({ success: true });
  } catch (err) {
    console.error('student-meta error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
