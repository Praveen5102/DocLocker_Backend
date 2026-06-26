const { findFolderByName, findFilesByName, readJsonFile, trashFilesByName, createJsonFile, getOrCreate } = require('./drive');

// student_meta.json lives in the "Others" subfolder; older students may still
// have it sitting at the folder root from before that change, so check both.
async function readStudentMeta(stuDirId) {
  const othersDir = await findFolderByName(stuDirId, 'Others');
  const candidates = othersDir ? await findFilesByName(othersDir.id, 'student_meta.json') : [];
  const files = candidates.length > 0 ? candidates : await findFilesByName(stuDirId, 'student_meta.json');
  if (files.length === 0) return { meta: {}, fileId: null };
  try { return { meta: await readJsonFile(files[0].id), fileId: files[0].id }; }
  catch { return { meta: {}, fileId: null }; }
}

async function writeStudentMeta(stuDirId, data) {
  const othersDir = await getOrCreate(stuDirId, 'Others');
  await trashFilesByName(stuDirId, 'student_meta.json'); // clean up legacy root-level copy, if any
  await trashFilesByName(othersDir.id, 'student_meta.json');
  return createJsonFile(othersDir.id, 'student_meta.json', data);
}

module.exports = { readStudentMeta, writeStudentMeta };
