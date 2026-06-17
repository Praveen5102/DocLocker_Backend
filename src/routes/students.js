const express = require('express');
const { ROOT_FOLDER_ID, sanitize, listFolders, findFilesByName, findFolderByName, readJsonFile, trashFile } = require('../services/drive');
const { verifyJWT } = require('../middleware/auth');
const { studentsCache } = require('../services/cache');

const router = express.Router();

// student_meta.json now lives in the "Others" subfolder; older students may still
// have it sitting at the folder root from before this change, so check both —
// in parallel, to avoid doubling/tripling per-folder Drive round trips.
async function findMetaFile(folderId) {
  const [othersDir, rootFiles] = await Promise.all([
    findFolderByName(folderId, 'Others'),
    findFilesByName(folderId, 'student_meta.json'),
  ]);
  if (othersDir) {
    const inOthers = await findFilesByName(othersDir.id, 'student_meta.json');
    if (inOthers.length > 0) return inOthers;
  }
  return rootFiles;
}

// GET /api/students — list all (JWT required)
router.get('/', verifyJWT, async (req, res) => {
  try {
    if (studentsCache.isValid()) {
      return res.json({ success: true, students: studentsCache.data });
    }

    const folders = await listFolders(ROOT_FOLDER_ID());
    const students = await Promise.all(
      folders.map(async (folder) => {
        const obj = { name: folder.name, driveUrl: folder.webViewLink };
        const metaFiles = await findMetaFile(folder.id);
        if (metaFiles.length > 0) {
          try {
            const meta = await readJsonFile(metaFiles[0].id);
            return { ...obj, ...meta };
          } catch (err) {
            return { ...obj, _parseError: err.message };
          }
        }
        return obj;
      })
    );

    studentsCache.set(students);
    res.json({ success: true, students });
  } catch (err) {
    console.error('listStudents error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/students/find?identifier= — public
router.get('/find', async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier) return res.status(400).json({ success: false, error: 'Missing identifier' });

    const folders = await listFolders(ROOT_FOLDER_ID());
    const results = await Promise.all(
      folders.map(async (folder) => {
        try {
          const metaFiles = await findMetaFile(folder.id);
          if (metaFiles.length === 0) return null;
          const meta = await readJsonFile(metaFiles[0].id);
          if (meta.email === identifier || meta.phone === identifier) {
            meta.driveUrl = folder.webViewLink;
            return meta;
          }
        } catch (_) {}
        return null;
      })
    );
    const match = results.find(Boolean);
    res.json({ success: !!match, student: match || null });
  } catch (err) {
    console.error('findStudent error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/students — delete student folder (JWT required)
router.delete('/', verifyJWT, async (req, res) => {
  try {
    const { studentName } = req.body;
    if (!studentName) return res.status(400).json({ success: false, error: 'Missing studentName' });

    const safeName = sanitize(studentName);
    const folders = await listFolders(ROOT_FOLDER_ID());
    const matches = folders.filter((f) => f.name === safeName);
    await Promise.all(matches.map((f) => trashFile(f.id)));

    studentsCache.clear();
    res.json({ success: true, deleted: matches.length });
  } catch (err) {
    console.error('deleteStudent error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
