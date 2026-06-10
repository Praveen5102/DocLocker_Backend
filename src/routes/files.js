const express = require('express');
const multer  = require('multer');
const {
  ROOT_FOLDER_ID, sanitize, getOrCreate,
  trashFilesByName, uploadBuffer, createJsonFile,
} = require('../services/drive');
const { convertToPdf, convertHtmlToPdf } = require('../services/pdf');
const { parseDocument }                  = require('../services/documentParser');
const { buildEligibilityHtml }           = require('../services/eligibilityReport');
const { studentsCache }                  = require('../services/cache');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/upload
// Returns parsedData in response — frontend holds this, no JSON saved to Drive
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { studentName, subFolder, fileName } = req.body;
    const file = req.file;
    if (!studentName || !subFolder || !fileName || !file) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const stuDir = await getOrCreate(ROOT_FOLDER_ID(), sanitize(studentName));
    const subDir = await getOrCreate(stuDir.id, sanitize(subFolder));

    const cleanNameNoExt = fileName.replace(/\.[^/.]+$/, '');

    await Promise.all([
      trashFilesByName(subDir.id, fileName),
      trashFilesByName(subDir.id, cleanNameNoExt + '.pdf'),
    ]);

    let finalBuffer   = file.buffer;
    let finalMimeType = file.mimetype;
    let finalFileName = fileName;

    const { pdfBuffer, extractedText } = await convertToPdf(file.buffer, file.mimetype, cleanNameNoExt);
    if (pdfBuffer) {
      finalBuffer   = pdfBuffer;
      finalMimeType = 'application/pdf';
      finalFileName = cleanNameNoExt + '.pdf';
    }

    const uploaded = await uploadBuffer(subDir.id, finalFileName, finalMimeType, finalBuffer);

    // Parse OCR text in-memory, return to frontend — nothing saved to Drive
    let parsedData = null;
    if (extractedText) {
      const parsed = parseDocument({ subFolder: sanitize(subFolder), sourceFile: finalFileName, extractedText });
      parsedData = { type: parsed.type, subFolder: sanitize(subFolder), sourceFile: finalFileName, fields: parsed.fields };
    }

    studentsCache.clear();
    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink, fileName: uploaded.name, parsedData });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/meta
router.post('/meta', async (req, res) => {
  try {
    const { studentName, metaJson } = req.body;
    if (!studentName || !metaJson) return res.status(400).json({ success: false, error: 'Missing studentName or metaJson' });

    const stuDir = await getOrCreate(ROOT_FOLDER_ID(), sanitize(studentName));
    await trashFilesByName(stuDir.id, 'student_meta.json');
    const file = await createJsonFile(stuDir.id, 'student_meta.json', JSON.parse(metaJson));

    studentsCache.clear();
    res.json({ success: true, fileId: file.id });
  } catch (err) {
    console.error('saveMeta error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/summary
// Body: { studentName, htmlContent, documents: [...parsedData] }
// documents = array of parsedData objects collected by frontend from upload responses
router.post('/summary', async (req, res) => {
  try {
    const { studentName, htmlContent, documents = [] } = req.body;
    if (!studentName || !htmlContent) return res.status(400).json({ success: false, error: 'Missing studentName or htmlContent' });

    const stuDir = await getOrCreate(ROOT_FOLDER_ID(), sanitize(studentName));

    // Summary PDF = exactly the frontend HTML
    await trashFilesByName(stuDir.id, 'Student_Summary.pdf');
    const summaryBuf      = await convertHtmlToPdf(htmlContent, sanitize(studentName));
    const summaryUploaded = await uploadBuffer(stuDir.id, 'Student_Summary.pdf', 'application/pdf', summaryBuf);

    // Eligibility report — auto-generated using documents passed from frontend
    let eligibilityReport = null;
    try {
      const eligHtml   = buildEligibilityHtml(sanitize(studentName), documents);
      await trashFilesByName(stuDir.id, 'Eligibility_Report.pdf');
      const eligBuf    = await convertHtmlToPdf(eligHtml, sanitize(studentName) + '_Elig');
      const eligUpload = await uploadBuffer(stuDir.id, 'Eligibility_Report.pdf', 'application/pdf', eligBuf);
      eligibilityReport = { fileId: eligUpload.id, webViewLink: eligUpload.webViewLink };
    } catch (e) {
      console.error('Eligibility report failed:', e.message);
    }

    res.json({
      success: true,
      fileId: summaryUploaded.id,
      webViewLink: summaryUploaded.webViewLink,
      ...(eligibilityReport && { eligibilityReport }),
    });
  } catch (err) {
    console.error('saveSummaryPdf error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/eligibility-report — standalone regeneration
// Body: { studentName, documents: [...parsedData] }
router.post('/eligibility-report', async (req, res) => {
  try {
    const { studentName, documents = [] } = req.body;
    if (!studentName) return res.status(400).json({ success: false, error: 'Missing studentName' });

    const stuDir   = await getOrCreate(ROOT_FOLDER_ID(), sanitize(studentName));
    const html     = buildEligibilityHtml(sanitize(studentName), documents);

    await trashFilesByName(stuDir.id, 'Eligibility_Report.pdf');
    const pdfBuf   = await convertHtmlToPdf(html, sanitize(studentName) + '_Elig');
    const uploaded = await uploadBuffer(stuDir.id, 'Eligibility_Report.pdf', 'application/pdf', pdfBuf);

    res.json({ success: true, fileId: uploaded.id, webViewLink: uploaded.webViewLink });
  } catch (err) {
    console.error('eligibilityReport error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
