// Client for our own document-reading model (10th / SSC, 12th certificate,
// passport, Aadhaar, PAN). Shared by the admin verification tool and the student
// upload flow so both send identical requests and get identical errors.

const READER_BASE_URL = process.env.DOCUMENT_READER_URL || 'https://certificate-reader-production.up.railway.app';

const MAX_FILES = { ssc: 1, certificate: 1, passport: 4, aadhaar: 4, pan: 4 };

// What the model accepts — .doc/.docx uploads still go through the old OCR.
const READER_MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/jpg', 'image/png',
  'image/tiff', 'image/bmp', 'image/webp',
]);

class ReaderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// files: [{ buffer, mimetype, originalname }] (multer's shape)
async function readDocument(docType, files, { consent = false } = {}) {
  if (!MAX_FILES[docType]) {
    throw new ReaderError(400, `Invalid doc_type. Must be one of: ${Object.keys(MAX_FILES).join(', ')}`);
  }
  if (!files || files.length === 0) throw new ReaderError(400, 'At least one file is required');
  if (files.length > MAX_FILES[docType]) {
    const max = MAX_FILES[docType];
    throw new ReaderError(400, `${docType} accepts at most ${max} file${max === 1 ? '' : 's'}`);
  }

  const form = new FormData();
  form.append('doc_type', docType);
  if (docType === 'aadhaar' && consent) form.append('consent', 'yes');
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
    throw new ReaderError(
      timedOut ? 504 : 502,
      timedOut ? 'Document reader timed out. Try again.' : 'Could not reach the document reader service.',
    );
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) throw new ReaderError(upstream.status, data?.detail || 'Document reader service error');
  return data;
}

// The slimmed result the student flow keeps: no base64 preview and no raw
// OCR text, so it stays small enough to live in student_meta.json.
function summarizeResult(docType, data) {
  const full = data?.full || {};
  const fields = {};
  for (const [name, f] of Object.entries(full.fields || {})) {
    if (f && typeof f === 'object') {
      fields[name] = { confidence: f.confidence ?? null, verified: f.verified ?? null, source: f.source || null };
    }
  }
  return {
    docType,
    flat: data?.flat || {},
    review: {
      status: full.review?.status || null,
      fieldsRequiringReview: full.review?.fields_requiring_review || [],
      reasons: full.review?.reasons || {},
    },
    fields,
    checks: {
      // The SSC reader says what it recognised instead of a supported flag.
      supported: full.supported ?? (docType === 'ssc' ? full.document_type === 'ssc' : null),
      mrzValid: full.mrz_valid ?? null,
      ...(full.checks || {}),
    },
    seconds: data?.seconds ?? null,
    readAt: new Date().toISOString(),
  };
}

// "SSC Public Examinations, March 2019" → "2019"
function examYear(exam) {
  const years = String(exam || '').match(/\b(19|20)\d{2}\b/g);
  return years ? years[years.length - 1] : undefined;
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

// Converts the model's output into the { type, fields } shape the old
// regex parser produced, so the eligibility report keeps working
// unchanged for these documents.
function toLegacyParsed(docType, flat, { subFolder, sourceFile }) {
  const fields = {};
  const set = (label, value) => { if (value !== undefined && value !== null && value !== '') fields[label] = String(value); };
  let type;

  if (docType === 'passport') {
    type = 'passport';
    set('Name', [flat.given_names, flat.surname].filter(Boolean).join(' '));
    set('Surname', flat.surname);
    set('Given Name', flat.given_names);
    set('Passport Number', flat.passport_number);
    set('Date of Birth', flat.date_of_birth);
    set('Gender', flat.sex);
    set('Nationality', flat.nationality);
    set('Place of Birth', flat.place_of_birth);
    set('Date of Issue', flat.date_of_issue);
    set('Date of Expiry', flat.date_of_expiry);
    set("Father's Name", flat.father_name);
    set("Mother's Name", flat.mother_name);
    set('Address', flat.address);
  } else if (docType === 'aadhaar') {
    type = 'aadhaar';
    set('Name', flat.name);
    set('Aadhaar Number', flat.aadhaar_number);
    set('Date of Birth', flat.date_of_birth);
    set('Gender', flat.gender);
    set('Care Of', [flat.relation, flat.care_of].filter(Boolean).join(' '));
    set('Address', flat.address);
  } else if (docType === 'pan') {
    type = 'pan';
    set('Name', flat.name);
    set('PAN Number', flat.pan_number);
    set("Father's Name", flat.father_name);
    set('Date of Birth', flat.date_of_birth);
  } else if (docType === 'certificate') {
    type = '12th';
    set('Name', flat.student_name);
    set("Father's Name", flat.father_name);
    set("Mother's Name", flat.mother_name);
    const pct = pick(flat.percentage);
    if (pct !== undefined) {
      set('Score Type', 'Percentage');
      set('Display Score', `${pct}%`);
      set('Percentage', `${Number(pct).toFixed(2)}%`);
    }
    if (flat.total_marks != null && flat.maximum_marks != null) set('Marks', `${flat.total_marks} / ${flat.maximum_marks}`);
    set('Year of Passing', flat.year_of_pass);
    set('Board / University', flat.board);
    set('Hall Ticket Number', flat.hall_ticket_number);
    set('Group', flat.group);
    set('Result', flat.result);
  } else if (docType === 'ssc') {
    type = '10th';
    set('Name', flat.student_name);
    set("Father's Name", flat.father_name);
    set("Mother's Name", flat.mother_name);
    set('Date of Birth', flat.date_of_birth);
    set('Roll Number', flat.roll_number);
    set('School', flat.school);
    set('Board / University', flat.board);
    set('Medium', flat.medium);
    const cgpa = Number(flat.cgpa);
    const pct = Number(flat.percentage);
    if (flat.result_type === 'grades' && flat.cgpa != null && Number.isFinite(cgpa)) {
      // Same CGPA → percentage convention the old parser uses (× 9.5).
      set('Score Type', 'CGPA');
      set('Display Score', `${cgpa.toFixed(1)} / 10`);
      set('CGPA', `${cgpa.toFixed(1)} / 10`);
      set('Percentage', `${(cgpa * 9.5).toFixed(2)}%`);
    } else if (flat.percentage != null && Number.isFinite(pct)) {
      set('Score Type', 'Percentage');
      set('Display Score', `${pct}%`);
      set('Percentage', `${pct.toFixed(2)}%`);
    }
    if (flat.total_marks != null && flat.maximum_marks != null) set('Marks', `${flat.total_marks} / ${flat.maximum_marks}`);
    set('Year of Passing', examYear(flat.exam));
  } else {
    return null;
  }

  return { type, subFolder, sourceFile, fields, source: 'reader' };
}

module.exports = { readDocument, summarizeResult, toLegacyParsed, ReaderError, READER_MIME_TYPES, MAX_FILES };
