const express = require('express');
const { ROOT_FOLDER_ID, cleanFolderKey, listFolders, findFilesByName, findFolderByName, readJsonFile, deletePermanently } = require('../services/drive');
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

// DELETE /api/students — permanently delete a student folder (staff only —
// both superadmin and advisor pass requireStaff; only banker accounts are blocked).
// Uses deletePermanently (hard delete), NOT trash — trashFile() only moves the
// folder into Drive's Trash: recoverable for 30 days and still counted against
// storage quota, so the student's data was never actually gone.
//
// Preferred path: delete by folderId (the exact Drive folder the admin is
// looking at, extracted client-side from the student's driveUrl). This is
// unambiguous — no string reconstruction involved.
//
// Fallback path (folderId not supplied — older clients): reconstruct the
// folder name from studentName and match by exact string. This is fragile —
// whitespace/casing drift between what's typed and what's on Drive, or a
// folder created under an older naming scheme, means zero folders match.
// Previously that case returned `{ success: true, deleted: 0 }`, so the
// frontend treated it as a successful delete and removed the row from view
// even though nothing was removed from Drive — the student reappeared on
// the next refresh. Now it's a 404, so the caller knows the delete did not
// happen and must not remove the row from its own list.
router.delete('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName, folderId } = req.body;

    if (folderId) {
      try {
        await deletePermanently(folderId);
      } catch (err) {
        // Already gone (e.g. a duplicate delete click) — treat as success.
        const status = err.code || err.response?.status;
        if (status !== 404) throw err;
      }
      studentsCache.clear();
      return res.json({ success: true, deleted: 1 });
    }

    if (!studentName) return res.status(400).json({ success: false, error: 'Missing studentName or folderId' });

    const safeName = cleanFolderKey(studentName);
    const folders = await listFolders(ROOT_FOLDER_ID());
    const matches = folders.filter((f) => f.name === safeName);
    if (matches.length === 0) {
      // Clear the cache anyway — a stale entry may be why the admin thinks
      // this student still exists when the folder is already gone.
      studentsCache.clear();
      return res.status(404).json({
        success: false,
        error: `No Drive folder matched "${safeName}" — nothing was deleted. Refresh the list and try again.`,
      });
    }

    await Promise.all(matches.map((f) => deletePermanently(f.id)));

    // Clear immediately so no request — from this admin or any other admin/
    // advisor session — can read a stale cached copy of the deleted student.
    studentsCache.clear();
    res.json({ success: true, deleted: matches.length });
  } catch (err) {
    console.error('deleteStudent error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
