const { findFolderByName, findFilesByName, readJsonFile, trashFile, createJsonFile, getOrCreate } = require('./drive');

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

// One write at a time per student folder. Without this, two saves landing
// together (e.g. two banker approvals clicked back to back) each created a
// copy and then trashed "every copy but mine" — trashing each other's copy and
// leaving the student with no meta at all, so they vanished from the list.
const locks = new Map();
function withStudentLock(stuDirId, fn) {
  const prev = locks.get(stuDirId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(stuDirId, tail);
  tail.then(() => { if (locks.get(stuDirId) === tail) locks.delete(stuDirId); });
  return run;
}

// Trash only the copies OLDER than the one just written. If a write from
// another server instance slipped in, its newer copy survives instead of
// being trashed, so the worst case is a leftover duplicate, never no meta.
async function trashOlderCopies(parentId, newFileId) {
  const files = await findFilesByName(parentId, 'student_meta.json'); // newest first
  const mine = files.findIndex((f) => f.id === newFileId);
  const older = mine === -1 ? files.filter((f) => f.id !== newFileId) : files.slice(mine + 1);
  await Promise.all(older.map((f) => trashFile(f.id)));
}

// Writes the new meta copy FIRST, then cleans up old copies (legacy root-level
// + any older Others/ copy). Writing first means a failed cleanup leaves a
// harmless duplicate rather than a missing file.
async function writeUnlocked(stuDirId, data) {
  const othersDir = await getOrCreate(stuDirId, 'Others');
  const newFile = await createJsonFile(othersDir.id, 'student_meta.json', data);
  await Promise.all([
    trashOlderCopies(othersDir.id, newFile.id),
    // Root-level copies are all legacy; the live copy is always in Others/.
    findFilesByName(stuDirId, 'student_meta.json').then((fs) => Promise.all(fs.map((f) => trashFile(f.id)))),
  ]);
  return newFile;
}

function writeStudentMeta(stuDirId, data) {
  return withStudentLock(stuDirId, () => writeUnlocked(stuDirId, data));
}

// Read-modify-write under the same lock, so a concurrent edit can't be lost
// (both approvals used to read the same old copy and each kept one banker).
function updateStudentMeta(stuDirId, mutate) {
  return withStudentLock(stuDirId, async () => {
    const { meta } = await readStudentMeta(stuDirId);
    const next = (await mutate(meta)) || meta;
    await writeUnlocked(stuDirId, next);
    return next;
  });
}

module.exports = { readStudentMeta, writeStudentMeta, updateStudentMeta };
