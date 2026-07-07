const express = require('express');
const { ROOT_FOLDER_ID, sanitize, listFolders, findFilesByName, findFolderByName, readJsonFile, trashFile } = require('../services/drive');
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
// Returns ONLY the student's name and folder URL — never full PII.
// The portal uses this to confirm the student exists so they can view their
// own documents. Full metadata is never sent to unauthenticated callers.
router.get('/find', async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier || identifier.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Missing or too-short identifier' });
    }

    const folders = await listFolders(ROOT_FOLDER_ID());
    const results = await Promise.all(
      folders.map(async (folder) => {
        try {
          const metaFiles = await findMetaFile(folder.id);
          if (metaFiles.length === 0) return null;
          const meta = await readJsonFile(metaFiles[0].id);
          if (meta.email === identifier || meta.phone === identifier) {
            // Return only what the portal needs — no PII beyond the name
            return { name: meta.name || folder.name, driveUrl: folder.webViewLink };
          }
        } catch (_) {}
        return null;
      })
    );
    const match = results.find(Boolean);
    // Constant-time-ish response shape regardless of found/not-found to
    // prevent trivial enumeration via timing differences
    res.json({ success: !!match, student: match || null });
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

    const safeName = sanitize(studentName);
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
