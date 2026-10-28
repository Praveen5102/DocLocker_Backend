// Sanction letters: the lender's approval, kept in the student's
// Loan_Documents section and recorded on the student (meta.sanctionLetter),
// so staff can see which sanctioned files still need one and the student can
// download it from their portal.
const { getOrCreate, uploadBuffer, trashFilesByNameExcept } = require('./drive');
const { storeDocument } = require('./studentStore');
const { visibleFiles } = require('./studentFiles');

const SECTION = 'Loan_Documents';
const BASE = 'Sanction_Letter';
const TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' };
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
// Every name a letter can be saved under; a new letter replaces them all
const LETTER_NAMES = ['pdf', 'jpg', 'jpeg', 'png'].map((e) => `${BASE}.${e}`);

// → { ext, mimeType } for a PDF / JPG / PNG upload, otherwise null
function letterType(file) {
  const byMime = TYPES[String(file?.mimetype || '').toLowerCase()];
  if (byMime) return { ext: byMime, mimeType: EXT_TYPES[byMime] };
  const ext = String(file?.originalname || '').split('.').pop().toLowerCase();
  return EXT_TYPES[ext] ? { ext: ext === 'jpeg' ? 'jpg' : ext, mimeType: EXT_TYPES[ext] } : null;
}

// Saves the letter (replacing any earlier one) → { fileId, name }
async function saveSanctionLetter(ref, file, uploadedBy) {
  const type = letterType(file);
  if (!type) throw Object.assign(new Error('The sanction letter must be a PDF, JPG or PNG file.'), { status: 400 });
  const fileName = `${BASE}.${type.ext}`;
  if (ref.kind === 'railway') {
    const saved = await storeDocument(ref, {
      section: SECTION, fileName, mimeType: type.mimeType, buffer: file.buffer, uploadedBy, replaces: LETTER_NAMES,
    });
    return { fileId: saved.id, name: saved.name };
  }
  // Drive: the new copy is saved first, older ones retired after
  const dir = await getOrCreate(ref.dir.id, SECTION);
  const uploaded = await uploadBuffer(dir.id, fileName, type.mimeType, file.buffer);
  await Promise.all(LETTER_NAMES.map((n) => trashFilesByNameExcept(dir.id, n, uploaded.id)));
  return { fileId: uploaded.id, name: uploaded.name };
}

// Any document whose name says it's a sanction letter ("Sanction_Letter.pdf",
// "HDFC sanction letter.pdf"…). Ranked: our own Loan_Documents/Sanction_Letter.*
// first, then anything in Loan_Documents, then the newest elsewhere.
const isLetterName = (name) => /sanction/i.test(String(name || ''));
function letterRank(f) {
  const inSection = String(f.group || '').split('/').pop() === SECTION;
  return (inSection ? 2 : 0) + (/^sanction_letter\./i.test(f.name || '') ? 1 : 0);
}

// A letter already in the file but not recorded on the student (saved
// before letters were recorded, or put in the folder by hand)
// → { fileId, name, section, uploadedAt, found: true } | null
async function findSanctionLetter(ref) {
  const letters = (await visibleFiles(ref))
    .filter((f) => isLetterName(f.name))
    .sort((a, b) => letterRank(b) - letterRank(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const f = letters[0];
  if (!f) return null;
  const at = f.updatedAt ? new Date(f.updatedAt).toISOString() : null;
  return { fileId: f.id, name: f.name, section: String(f.group || '').split('/').pop() || null, uploadedAt: at, found: true };
}

const LETTER_STAGES = new Set(['sanctioned', 'disbursed']);

// The student's letter: the recorded one, or one found in their file when
// the loan is sanctioned or disbursed. Never writes anything.
async function sanctionLetterOf(ref, meta = {}) {
  if (meta.sanctionLetter) return meta.sanctionLetter;
  if (!LETTER_STAGES.has(meta.loanStatus)) return null;
  return findSanctionLetter(ref).catch(() => null);
}

module.exports = { saveSanctionLetter, findSanctionLetter, sanctionLetterOf, letterType, LETTER_STAGES };
