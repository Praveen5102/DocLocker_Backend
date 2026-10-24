// The documents in a student's file, for either kind of student — shared by
// the lender view and the applicant's own dashboard.
const { listAllFilesRecursive, readFileBuffer } = require('./drive');
const { listDocuments, readDocumentBytes } = require('./studentStore');

// Internal files nobody outside staff sees.
const EXCLUDED_FILENAMES = new Set(['student_meta.json', 'eligibility_report.pdf']);

// → [{ id, name, mimeType, size, group }] — group is the section/subfolder.
async function visibleFiles(ref) {
  const files = ref.kind === 'railway'
    ? (await listDocuments(ref)).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType, size: d.size, group: d.section, updatedAt: d.uploadedAt || d.createdAt || null }))
    : (await listAllFilesRecursive(ref.dir.id)).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, group: f.relativePath, updatedAt: f.modifiedTime || null }));
  return files.filter((f) => !EXCLUDED_FILENAMES.has(String(f.name).toLowerCase()));
}

async function fileBytes(ref, file) {
  if (ref.kind === 'railway') return (await readDocumentBytes(file.id)).buffer;
  return readFileBuffer(file.id);
}

module.exports = { visibleFiles, fileBytes, EXCLUDED_FILENAMES };
