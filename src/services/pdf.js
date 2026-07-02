const { Readable } = require('stream');
const { PDFDocument } = require('pdf-lib');
const { getDrive } = require('./drive');

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
const DOC_TYPES = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

async function convertToPdf(buffer, mimeType, baseName) {
  if (IMAGE_TYPES.includes(mimeType)) {
    return convertImageToPdf(buffer, mimeType, baseName);
  }
  if (DOC_TYPES.includes(mimeType)) {
    return convertDocToPdf(buffer, mimeType, baseName);
  }
  if (mimeType === 'application/pdf') {
    // Already a PDF — keep it as-is, just run OCR for text extraction
    const extractedText = await extractTextViaOcr(buffer, mimeType, baseName);
    return { pdfBuffer: null, extractedText };
  }
  return { pdfBuffer: null, extractedText: null };
}

// Images: pdfkit for clean 1-page PDF + Google Drive OCR for text only
async function convertImageToPdf(buffer, mimeType, baseName) {
  const [pdfBuffer, extractedText] = await Promise.all([
    buildImagePdf(buffer, mimeType),
    extractTextViaOcr(buffer, mimeType, baseName),
  ]);
  return { pdfBuffer, extractedText };
}

// Word docs: Google Drive handles PDF conversion cleanly (no extra OCR pages)
async function convertDocToPdf(buffer, mimeType, baseName) {
  const drive = getDrive();
  let tempId = null;
  try {
    const upload = await drive.files.create({
      requestBody: { name: `Temp_${baseName}`, mimeType: 'application/vnd.google-apps.document' },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id',
    });
    tempId = upload.data.id;

    const [pdfExport, textExport] = await Promise.all([
      drive.files.export({ fileId: tempId, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' }),
      drive.files.export({ fileId: tempId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' }).catch(() => null),
    ]);

    const pdfBuffer = Buffer.from(pdfExport.data);
    const extractedText = textExport ? Buffer.from(textExport.data).toString('utf-8').trim() : null;

    return { pdfBuffer, extractedText };
  } catch (err) {
    console.error('Doc PDF conversion failed:', err.message);
    return { pdfBuffer: null, extractedText: null };
  } finally {
    if (tempId) {
      try { await drive.files.delete({ fileId: tempId }); } catch (_) {}
    }
  }
}

// Build a clean single-page PDF from an image buffer using pdf-lib (embeds image as-is, no re-encoding)
async function buildImagePdf(buffer, mimeType) {
  const pdfDoc = await PDFDocument.create();
  const image = mimeType === 'image/png'
    ? await pdfDoc.embedPng(buffer)
    : await pdfDoc.embedJpg(buffer);

  const { width, height } = image.size();
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });

  return Buffer.from(await pdfDoc.save());
}

// Upload image to Google Drive as Google Doc to trigger OCR, export text only, then delete
async function extractTextViaOcr(buffer, mimeType, baseName) {
  const drive = getDrive();
  let tempId = null;
  try {
    const upload = await drive.files.create({
      requestBody: { name: `Temp_OCR_${baseName}`, mimeType: 'application/vnd.google-apps.document' },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id',
    });
    tempId = upload.data.id;

    const textExport = await drive.files.export(
      { fileId: tempId, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(textExport.data).toString('utf-8').trim() || null;
  } catch (err) {
    console.error('OCR extraction failed:', err.message);
    return null;
  } finally {
    if (tempId) {
      try { await drive.files.delete({ fileId: tempId }); } catch (_) {}
    }
  }
}

async function convertHtmlToPdf(htmlContent, label) {
  const drive = getDrive();
  let tempId = null;
  try {
    const upload = await drive.files.create({
      requestBody: { name: `Temp_Summary_${label}`, mimeType: 'application/vnd.google-apps.document' },
      media: { mimeType: 'text/html', body: Readable.from(Buffer.from(htmlContent, 'utf-8')) },
      fields: 'id',
    });
    tempId = upload.data.id;
    const exported = await drive.files.export(
      { fileId: tempId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(exported.data);
  } finally {
    if (tempId) {
      try { await drive.files.delete({ fileId: tempId }); } catch (_) {}
    }
  }
}

module.exports = { convertToPdf, convertHtmlToPdf, extractTextViaOcr };
