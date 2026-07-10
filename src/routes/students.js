const express = require('express');
const { ROOT_FOLDER_ID, sanitize, cleanFolderKey, listFolders, findFilesByName, findFolderByName, readJsonFile, trashFile } = require('../services/drive');
const { verifyJWT, requireStaff } = require('../middleware/auth');
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
// Bankers never receive the full list over the wire — only students they've
// been explicitly granted access to, filtered server-side before responding.
router.get('/', verifyJWT, async (req, res) => {
  try {
    let students;
    if (studentsCache.isValid()) {
      students = studentsCache.data;
    } else {
      const folders = await listFolders(ROOT_FOLDER_ID());
      students = await Promise.all(
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
    }

    if (req.admin.role === 'banker') {
      students = students.filter((s) => (s.sharedBankers || []).includes(req.admin.name));
    }

    res.json({ success: true, students });
  } catch (err) {
    console.error('listStudents error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/students/find?identifier= — used by the student self-service portal
// Warm cache: email/phone field match (0 Drive calls).
// Cold / new student: folder name suffix match (1 Drive call, 0 meta reads).
router.get('/find', async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier || identifier.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Missing or too-short identifier' });
    }

    const safeId = identifier.trim().replace(/[^a-zA-Z0-9@._+-]/g, '');

    // 1. Warm cache — full meta is already in memory, return it all
    if (studentsCache.isValid()) {
      const hit = studentsCache.data.find((s) => s.email === safeId || s.phone === safeId);
      if (hit) {
        // Spread full meta so the portal can pre-populate all fields on resume
        return res.json({ success: true, student: { ...hit } });
      }
      // Not in warm cache (new student) — fall through to Drive scan
    }

    // 2. Cold / new student — match by folder name suffix (no meta reads for lookup)
    // Try both @-preserved and sanitized suffix to handle folders created by different code paths
    const suffix = `__${safeId}`;
    const suffixSanitized = `__${safeId.replace(/[^a-zA-Z0-9 _\-.]/g, '_')}`;
    const folders = await listFolders(ROOT_FOLDER_ID());
    const match = folders.find(
      (f) => f.name && (f.name.endsWith(suffix) || f.name.endsWith(suffixSanitized))
    );

    if (match) {
      const displayName = match.name.split('__')[0] || match.name;
      let studentData = { name: displayName, driveUrl: match.webViewLink };
      // Read meta so the portal gets the full picture on resume
      try {
        const metaFiles = await findMetaFile(match.id);
        if (metaFiles.length > 0) {
          const meta = await readJsonFile(metaFiles[0].id);
          studentData = { driveUrl: match.webViewLink, ...meta, name: meta.name || displayName };
        }
      } catch (_) {}
      return res.json({ success: true, student: studentData });
    }
    res.json({ success: false, student: null });
  } catch (err) {
    console.error('findStudent error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/students — delete student folder (staff only)
router.delete('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName } = req.body;
    if (!studentName) return res.status(400).json({ success: false, error: 'Missing studentName' });

    const safeName = cleanFolderKey(studentName);
    const folders = await listFolders(ROOT_FOLDER_ID());
    const matches = folders.filter((f) => f.name === safeName);
    await Promise.all(matches.map((f) => trashFile(f.id)));

    studentsCache.clear();
    res.json({ success: true, deleted: matches.length });
  } catch (err) {
    console.error('deleteStudent error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
