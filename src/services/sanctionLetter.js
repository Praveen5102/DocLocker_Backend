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

// A letter already in the file but not yet recorded on the student (saved
// before letters were recorded) → { fileId, name, uploadedAt } | null
async function findSanctionLetter(ref) {
  const letters = (await visibleFiles(ref))
    .filter((f) => String(f.group || '').split('/').pop() === SECTION && /^sanction_letter\./i.test(f.name || ''))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const f = letters[0];
  if (!f) return null;
  const at = f.updatedAt ? new Date(f.updatedAt).toISOString() : null;
  return { fileId: f.id, name: f.name, uploadedAt: at };
}

module.exports = { saveSanctionLetter, findSanctionLetter, letterType };
