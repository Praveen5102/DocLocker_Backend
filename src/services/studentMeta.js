const { findFolderByName, findFilesByName, readJsonFile, trashFilesByNameExcept, createJsonFile, getOrCreate } = require('./drive');

// student_meta.json lives in the "Others" subfolder; older students may still
// have it sitting at the folder root from before that change, so check both.
// findFilesByName returns newest-first, so files[0] is always the most
// recently written copy even if an old duplicate is still lying around.
async function readStudentMeta(stuDirId) {
  const othersDir = await findFolderByName(stuDirId, 'Others');
  const candidates = othersDir ? await findFilesByName(othersDir.id, 'student_meta.json') : [];
  const files = candidates.length > 0 ? candidates : await findFilesByName(stuDirId, 'student_meta.json');
  if (files.length === 0) return { meta: {}, fileId: null };
  return { meta: await readJsonFile(files[0].id), fileId: files[0].id };
}

// Writes the new meta copy FIRST, then cleans up old copies (legacy root-level
// + any older Others/ copy), excluding the file just written. Previously this
// trashed the old copies BEFORE creating the new one — if createJsonFile then
// failed (network blip, Drive hiccup), the student's meta was simply gone: no
// old copy (trashed) and no new copy (never created). Writing first means the
// worst case on a cleanup failure is a harmless leftover duplicate, never a
// missing file.
async function writeStudentMeta(stuDirId, data) {
  const othersDir = await getOrCreate(stuDirId, 'Others');
  const newFile = await createJsonFile(othersDir.id, 'student_meta.json', data);
  await Promise.all([
    trashFilesByNameExcept(stuDirId, 'student_meta.json', newFile.id),
    trashFilesByNameExcept(othersDir.id, 'student_meta.json', newFile.id),
  ]);
  return newFile;
}

module.exports = { readStudentMeta, writeStudentMeta };
