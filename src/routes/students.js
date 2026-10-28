const express = require('express');
const { ROOT_FOLDER_ID, cleanFolderKey, listFolders, readJsonFile, deletePermanently } = require('../services/drive');
const { verifyJWT, requireCompanyAdmin, studentCompany } = require('../middleware/auth');
const { studentsCache } = require('../services/cache');
const { logAudit } = require('../services/auditLog');
const {
  listRailwayStudents, resolveStudent, deleteRailwayStudent,
} = require('../services/studentStore');
const { includesOwner, ownerOrgId } = require('../services/tenantScope');
const { parseIdentifier, locateStudent, findMetaFile, warmDriveContacts } = require('../services/studentLocator');
const { canSeeMeta } = require('../services/access');
const { findSanctionLetter, LETTER_STAGES } = require('../services/sanctionLetter');

const router = express.Router();
warmDriveContacts();

// GET /api/students — the students the caller may see (JWT required).
// Scoped to the caller's company, then filtered server-side before anything
// goes over the wire: staff get only students assigned to them, lenders only
// students shared with them.
router.get('/', verifyJWT, async (req, res) => {
  try {
    let students;
    if (studentsCache.isValid()) {
      students = studentsCache.data;
    } else {
      // New students live on Railway, everyone else in Drive — one list.
      // Drive students all belong to Flyurdream.
      const withDrive = await includesOwner();
      const owner = withDrive ? { id: await ownerOrgId(), name: 'Flyurdream', slug: 'flyurdream' } : null;
      const [folders, railwayStudents] = await Promise.all([
        withDrive ? listFolders(ROOT_FOLDER_ID()) : [],
        listRailwayStudents(),
      ]);
      // A Drive folder whose student has moved to Railway is only a backup
      // copy now — listing it too would show the student twice.
      const moved = new Set(railwayStudents.map((s) => s.studentKey));
      const driveStudents = await Promise.all(
        folders.filter((folder) => !moved.has(folder.name)).map(async (folder) => {
          const obj = { name: folder.name, driveUrl: folder.webViewLink, company: owner };
          const { metaFiles, summaryFile, eligibilityFile } = await findMetaFile(folder.id);
          const summaryPdf = summaryFile
            ? { fileId: summaryFile.id, webViewLink: summaryFile.webViewLink, updatedAt: summaryFile.modifiedTime }
            : null;
          const eligibilityPdf = eligibilityFile
            ? { fileId: eligibilityFile.id, webViewLink: eligibilityFile.webViewLink, updatedAt: eligibilityFile.modifiedTime }
            : null;
          if (metaFiles.length > 0) {
            // Drive's own file modifiedTime — a genuine "last updated" stamp
            // for the row, not something read from (and possibly stale
            // inside) the meta JSON's own content.
            const updatedAt = metaFiles[0].modifiedTime || null;
            try {
              const meta = await readJsonFile(metaFiles[0].id);
              // A letter saved before letters were recorded: found in the folder
              const sanctionLetter = meta.sanctionLetter || (LETTER_STAGES.has(meta.loanStatus)
                ? await findSanctionLetter({ kind: 'drive', dir: { id: folder.id } }).catch(() => null)
                : null) || undefined;
              return { ...obj, ...meta, sanctionLetter, updatedAt, summaryPdf, eligibilityPdf };
            } catch (err) {
              return { ...obj, _parseError: err.message, updatedAt, summaryPdf, eligibilityPdf };
            }
          }
          return { ...obj, summaryPdf, eligibilityPdf };
        })
      );
      students = [...railwayStudents, ...driveStudents];
      studentsCache.set(students);
    }

    students = students.filter((s) => canSeeMeta(req.admin, s));

    res.json({ success: true, students });
  } catch (err) {
    console.error('listStudents error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/students/find?identifier= — does an application exist for this
// email / mobile number? Used by signup to stop duplicates. It never returns
// the application itself: that needs the applicant's PIN (routes/applicant.js).
router.get('/find', studentCompany, async (req, res) => {
  try {
    const id = parseIdentifier(req.query.identifier);
    if (!id) return res.status(400).json({ success: false, error: 'Enter the email or 10-digit mobile number you registered with' });
    const found = await locateStudent(id, { viaCompanyLink: req.viaCompanyLink, companyId: req.companyId });
    res.json({ success: true, exists: Boolean(found) });
  } catch (err) {
    console.error('findStudent error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/students — permanently delete a student. Company admins and
// superadmin only; a company admin only ever reaches their own students.
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
router.delete('/', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const { studentName, folderId, studentKey } = req.body;

    // Railway students are addressed by their student key (no Drive folder).
    if (studentKey) {
      const ref = await resolveStudent(studentKey);
      if (!ref || ref.kind !== 'railway') {
        studentsCache.clear();
        return res.status(404).json({ success: false, error: 'Student not found — nothing was deleted. Refresh the list and try again.' });
      }
      const { documents } = await deleteRailwayStudent(ref);
      studentsCache.clear();
      logAudit({ actor: req.admin.name, role: req.admin.role, action: 'student.delete', target: ref.key, details: { storage: 'railway', documents } });
      return res.json({ success: true, deleted: 1 });
    }

    // Drive students are Flyurdream's; a partner admin can't reach them.
    if (!(await includesOwner())) {
      return res.status(404).json({ success: false, error: 'Student not found — nothing was deleted.' });
    }

    if (folderId) {
      // Only a student folder (a direct child of the DocLocker root) may be
      // deleted — never an arbitrary Drive id.
      const studentFolders = await listFolders(ROOT_FOLDER_ID());
      if (!studentFolders.some((f) => f.id === folderId)) {
        studentsCache.clear();
        return res.status(404).json({ success: false, error: 'Student not found — nothing was deleted. Refresh the list and try again.' });
      }
      try {
        await deletePermanently(folderId);
      } catch (err) {
        // Already gone (e.g. a duplicate delete click) — treat as success.
        const status = err.code || err.response?.status;
        if (status !== 404) throw err;
      }
      studentsCache.clear();
      logAudit({ actor: req.admin.name, role: req.admin.role, action: 'student.delete', target: studentName || folderId });
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
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'student.delete', target: safeName, details: { count: matches.length } });
    res.json({ success: true, deleted: matches.length });
  } catch (err) {
    console.error('deleteStudent error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
