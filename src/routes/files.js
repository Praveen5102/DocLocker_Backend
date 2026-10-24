const express = require('express');
const multer  = require('multer');
const {
  sanitize, buildFolderKey, cleanFolderKey, folderKeyDisplayName,
  getOrCreate, trashFilesByNameExcept, uploadBuffer,
  findFolderByName, listFilesInFolder, readFileBuffer,
} = require('../services/drive');
const { convertToPdf, convertHtmlToPdf } = require('../services/pdf');
const { parseDocument }                  = require('../services/documentParser');
const { buildEligibilityHtml }           = require('../services/eligibilityReport');
const {
  resolveStudent, readMeta, writeMeta, storeDocument, listDocuments, readDocumentBytes,
} = require('../services/studentStore');
const { readerForSlot, slotBase, checkUpload } = require('../services/uploadGate');
const { summarizeResult, toLegacyParsed } = require('../services/documentReader');
const { studentsCache }                  = require('../services/cache');
const { verifyJWT, requireStaff, requireApplicant, scopedUpload } = require('../middleware/auth');
const { staffStudent } = require('../services/access');
const { mergeStudentMeta } = require('../services/protectedMeta');
const { logAudit }                       = require('../services/auditLog');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

// Pages already saved for a two-page slot (e.g. the passport photo page when
// the last page arrives), so the new page is checked together with them.
// `replacing` = names this upload overwrites, which aren't context.
const MAX_CONTEXT_BYTES = 20 * 1024 * 1024;
async function slotContextPages(ref, section, fileName, replacing) {
  const base = slotBase(fileName);
  const isSlotPage = (name) => slotBase(name) === base && !replacing.includes(name);
  if (ref.kind === 'railway') {
    const docs = (await listDocuments(ref)).filter((d) => d.section === section && isSlotPage(d.name)).slice(-3);
    const pages = await Promise.all(docs.map(async (d) => {
      const f = await readDocumentBytes(d.id);
      return f && { buffer: f.buffer, mimetype: f.mimeType, originalname: f.name };
    }));
    return pages.filter((pg) => pg && pg.buffer.length <= MAX_CONTEXT_BYTES);
  }
  const subDir = await findFolderByName(ref.dir.id, section);
  if (!subDir) return [];
  const files = (await listFilesInFolder(subDir.id))
    .filter((f) => isSlotPage(f.name) && Number(f.size || 0) <= MAX_CONTEXT_BYTES)
    .slice(0, 3);
  return Promise.all(files.map(async (f) => ({ buffer: await readFileBuffer(f.id), mimetype: f.mimeType, originalname: f.name })));
}

// Reads ID / certificate slots BEFORE saving (services/uploadGate.js): a
// wrong document is rejected and never stored. Every other slot is saved
// as before. Returns { rejected, reason } or { result } (the API fields).
async function processUpload(ref, { subFolder, fileName, file, skipOcr, uploadedBy }) {
  const section = sanitize(subFolder);
  const cleanNameNoExt = fileName.replace(/\.[^/.]+$/, '');
  const docType = readerForSlot(fileName);
  // Certificates always get the old text reading: it's how memos from
  // boards our model doesn't read are recognised.
  const needsText = docType === 'ssc' || docType === 'certificate';
  const convertedP = convertToPdf(file.buffer, file.mimetype, cleanNameNoExt, { skipOcr: skipOcr && !needsText });
  convertedP.catch(() => {}); // awaited below; never an unhandled rejection meanwhile

  let check = null;
  if (docType) {
    const multiPage = docType === 'passport' || docType === 'aadhaar';
    const context = multiPage
      ? await slotContextPages(ref, section, fileName, [fileName, `${cleanNameNoExt}.pdf`]).catch(() => [])
      : [];
    check = await checkUpload({
      docType,
      files: [...context, { buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname || fileName }],
      ocrText: convertedP.then((c) => c.extractedText),
    });
    if (check.gate.status === 'rejected') return { rejected: true, reason: check.gate.reason, docType };
  }

  const converted = await convertedP;
  const result = await saveUpload(ref, { subFolder, fileName, file, converted, uploadedBy });
  if (check) {
    result.reader = { gate: check.gate };
    if (check.data) {
      result.reader.extraction = { ...summarizeResult(docType, check.data), gate: check.gate };
      result.reader.parsedData = toLegacyParsed(docType, check.data.flat || {}, { subFolder: section, sourceFile: result.fileName });
    }
  }
  return { result };
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
router.post('/upload', verifyJWT, requireStaff, scopedUpload(upload.single('file')), async (req, res) => {
  try {
    const { studentName, subFolder, fileName } = req.body;
    const skipOcr = req.body.skipOcr === '1';
    const file = req.file;
    if (!studentName || !subFolder || !fileName || !file) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const ref = await staffStudent(req.admin, cleanFolderKey(studentName), { create: true });
    const out = await processUpload(ref, { subFolder, fileName, file, skipOcr, uploadedBy: req.admin.name });
    if (out.rejected) {
      logAudit({
        actor: req.admin.name, role: req.admin.role, action: 'document.rejected',
        target: ref.key, details: { subFolder: sanitize(subFolder), fileName, docType: out.docType },
      });
      return res.status(422).json({ success: false, rejected: true, error: out.reason });
    }
    res.json({ success: true, ...out.result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
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

    const ref  = await staffStudent(req.admin, cleanFolderKey(studentName), { create: true });
    const existing = await readMeta(ref).catch(() => ({}));
    const file = await writeMeta(ref, mergeStudentMeta(existing, metaObj, req.admin));

    studentsCache.clear();
    res.json({ success: true, ...(file && file.id && { fileId: file.id }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
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
    const ref      = await staffStudent(req.admin, cleanFolderKey(studentName), { create: true });

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
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
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
    const ref      = await staffStudent(req.admin, cleanFolderKey(studentName));
    const html     = buildEligibilityHtml(dispName, documents);
    const pdfBuf   = await convertHtmlToPdf(html, dispName + '_Elig');

    const uploaded = await saveGeneratedPdf(ref, 'Eligibility_Report.pdf', pdfBuf, req.admin.name);
    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink || null });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('eligibilityReport error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Student self-service upload ─────────────────────────────────────────────
// The application comes from the applicant's PIN session (requireApplicant),
// never from the form: a student can only ever add to their own file.
const displayNameOf = (ref) => sanitize(ref.key.split('__')[0] || ref.key);

router.post('/student-upload', requireApplicant, scopedUpload(upload.single('file')), async (req, res) => {
  try {
    const { subFolder, fileName } = req.body;
    const file = req.file;
    if (!subFolder || !fileName || !file) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const skipOcr = req.body.skipOcr === '1';
    const ref = req.studentRef;
    const studentName = displayNameOf(ref);

    const out = await processUpload(ref, {
      subFolder: subFolder.trim(), fileName, file, skipOcr, uploadedBy: studentName,
    });
    if (out.rejected) {
      logAudit({
        actor: studentName, role: 'student', action: 'document.rejected',
        target: ref.key, details: { subFolder: sanitize(subFolder), fileName, docType: out.docType },
      });
      return res.status(422).json({ success: false, rejected: true, error: out.reason });
    }
    const result = out.result;

    logAudit({
      actor: studentName, role: 'student', action: 'document.upload',
      target: ref.key,
      details: { subFolder: sanitize(subFolder), fileName: result.fileName, ...(result.reader && { check: result.reader.gate.status }) },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('student-upload error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/student-summary — the signed-in applicant's summary + eligibility
// PDF. Mirrors staff /api/summary. This is the ONLY caller in practice — the
// student portal generates its own summary PDF on every save.
//
// The summary PDF itself now arrives pre-rendered as a real file (multipart
// field "summaryPdf") — summaryGenerator.js builds it client-side with
// html2canvas + jsPDF so it can use real CSS (grid/flexbox/gradients/custom
// properties), none of which survive the convertHtmlToPdf() pipeline below
// (a Google Docs HTML import, not a browser engine). The eligibility report
// alongside it is unaffected — it's simple enough to stay on that pipeline.
// Body (multipart/form-data): documents (JSON-encoded [...parsedData]),
// summaryPdf (file)
router.post('/student-summary', requireApplicant, scopedUpload(upload.single('summaryPdf')), async (req, res) => {
  try {
    let documents = [];
    try { documents = req.body.documents ? JSON.parse(req.body.documents) : []; }
    catch (_) { documents = []; }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Missing summaryPdf' });
    }
    const ref = req.studentRef;
    const dispName = displayNameOf(ref);

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
      target: ref.key, details: null,
    });

    res.json(response);
  } catch (err) {
    console.error('student-summary error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/student-meta — the signed-in applicant saves their record.
// (Registration creates it: POST /api/applicant/register.)
router.post('/student-meta', requireApplicant, async (req, res) => {
  try {
    const { metaJson } = req.body;
    if (!metaJson) {
      return res.status(400).json({ success: false, error: 'Missing metaJson' });
    }
    let metaObj;
    try { metaObj = JSON.parse(metaJson); }
    catch { return res.status(400).json({ success: false, error: 'Invalid JSON in metaJson' }); }
    const ref = req.studentRef;

    // Staff-owned fields (loan status, lender sharing…) keep their stored values.
    const existing = await readMeta(ref).catch(() => ({}));
    await writeMeta(ref, mergeStudentMeta(existing, metaObj, 'student'));

    studentsCache.clear();
    logAudit({
      actor: displayNameOf(ref), role: 'student', action: 'student.save',
      target: ref.key, details: { storage: ref.kind },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('student-meta error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
