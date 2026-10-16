// Upload gate: an ID or certificate slot only accepts the document it asks
// for. The file is read by our document model BEFORE anything is saved; a
// wrong document (a PAN card in the passport slot, a photo in the 10th
// marksheet slot…) is rejected and never stored.
//
// The slot is worked out on the server from the saved file name, so the
// rule can't be skipped by a modified browser.
//
// Outcomes:
//   accepted   — recognised as the right document
//   rejected   — clearly not that document; nothing is saved
//   unverified — couldn't be checked (reader down, Word file…); saved, and
//                shown to staff as not verified. A reader outage must never
//                stop students from uploading.
//
// 10th / 12th certificates from boards our model doesn't read (CBSE, ICSE,
// other states) are not rejected: the old text reading is used to confirm
// the file at least looks like a marks memo.

const { readDocument, READER_MIME_TYPES, ReaderError } = require('./documentReader');

// Saved file name (without extension and page suffix) → reader type.
const SLOT_READERS = {
  Passport: 'passport',
  PAN_Card: 'pan',
  PAN: 'pan',
  Aadhar_Card: 'aadhaar',
  Aadhar: 'aadhaar',
  '10th_Marksheet': 'ssc',
  '12th_Marksheet': 'certificate',
};

// Two-page documents: the first page is the slot name, later pages get _1, _2…
const slotBase = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '').replace(/_\d+$/, '');
const readerForSlot = (fileName) => SLOT_READERS[slotBase(fileName)] || null;

const LABEL = {
  passport: 'a passport',
  aadhaar: 'an Aadhaar card',
  pan: 'a PAN card',
  ssc: 'a 10th marks memo',
  certificate: 'a 12th marks memo',
};

const REJECT_HINT = {
  passport: 'Please upload the passport photo page first (the page with your photo and the two lines of code at the bottom), then the last page.',
  aadhaar: 'Please upload the front or back of your Aadhaar card, or your e-Aadhaar.',
  pan: 'Please upload the front of your PAN card, with the PAN number clearly visible.',
  ssc: 'Please upload your 10th (SSC) marks memo.',
  certificate: 'Please upload your 12th / Intermediate marks memo.',
};

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Does the old text reading look like a marks memo? Needs several distinct
// marks-memo words, so a random photo or letter doesn't pass.
const MEMO_WORDS = [
  /\bmarks?\b/, /\bgrade/, /\bexamination\b/, /\bboard\b/, /\bcertificate\b/, /\bschool\b/,
  /\bsecondary\b/, /\bintermediate\b/, /\bsenior\b/, /\bsubject/, /\bcbse\b/, /\bicse\b/, /\bresult\b/,
  /\bcgpa\b/, /\broll\b/, /\bmatric/, /\bhsc\b/, /\bssc\b/, /\bpercentage\b/, /\btotal\b/,
];
function looksLikeMarksMemo(text) {
  const t = String(text || '').toLowerCase();
  return MEMO_WORDS.filter((re) => re.test(t)).length >= 3;
}

// The verdict for one read. `ocrText` is the old reader's text (only
// produced for certificate slots), used for other-board memos.
function assess(docType, data, ocrText) {
  const full = data?.full || {};
  const flat = data?.flat || {};
  const kind = full.document_type ?? flat.document_type ?? null;

  switch (docType) {
    case 'passport': {
      const hasMrz = full.mrz_valid === true || (Array.isArray(full.mrz_lines) && full.mrz_lines.length > 0);
      return kind === 'passport' && (filled(flat.passport_number) || hasMrz);
    }
    case 'aadhaar':
      return kind !== 'unknown' && (filled(flat.aadhaar_number) || filled(flat.name));
    case 'pan':
      return kind === 'pan' && PAN_RE.test(String(flat.pan_number || '').toUpperCase());
    case 'ssc':
      if (kind === 'ssc') return true;
      return looksLikeMarksMemo(ocrText) ? 'other_board' : false;
    case 'certificate':
      if (full.supported !== false) return true;
      return looksLikeMarksMemo(ocrText) ? 'other_board' : false;
    default:
      return true;
  }
}

// Reads `files` (context pages already saved for this slot + the new page)
// and decides. Returns { gate, data }:
//   gate: { status, docType, reason? }   data: the reader's raw result or null
async function checkUpload({ docType, files, ocrText }) {
  const readable = files.filter((f) => READER_MIME_TYPES.has(f.mimetype));
  const newFile = files[files.length - 1];
  if (!READER_MIME_TYPES.has(newFile.mimetype)) {
    return { gate: { status: 'unverified', docType, reason: 'This file type can’t be checked automatically.' }, data: null };
  }

  // ocrText may be a promise (the old text reading runs alongside); it's
  // only waited for when a certificate needs the other-board fallback.
  let data;
  try {
    data = await readDocument(docType, readable.slice(-4));
  } catch (err) {
    const reason = err instanceof ReaderError && err.status < 500
      ? `Could not be checked (${err.message}).`
      : 'Could not be checked right now — the document reader is unavailable.';
    return { gate: { status: 'unverified', docType, reason }, data: null };
  }

  const needsText = docType === 'ssc' || docType === 'certificate';
  const text = needsText ? await Promise.resolve(ocrText).catch(() => '') : '';
  const verdict = assess(docType, data, text);
  if (verdict === false) {
    return {
      gate: {
        status: 'rejected',
        docType,
        reason: `This doesn’t look like ${LABEL[docType]}. ${REJECT_HINT[docType]}`,
      },
      data,
    };
  }
  if (verdict === 'other_board') {
    return {
      gate: { status: 'accepted', docType, reason: 'Board not read by our model yet — accepted from the text on the memo.' },
      data,
    };
  }
  return { gate: { status: 'accepted', docType }, data };
}

module.exports = { readerForSlot, slotBase, checkUpload, assess, looksLikeMarksMemo };
