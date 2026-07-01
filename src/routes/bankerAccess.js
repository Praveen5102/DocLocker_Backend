const express = require('express');
const {
  ROOT_FOLDER_ID, sanitize, buildFolderKey, findFolderByName, listAllFilesRecursive,
} = require('../services/drive');
const { readStudentMeta, writeStudentMeta } = require('../services/studentMeta');
const { verifyJWT, requireStaff } = require('../middleware/auth');
const { studentsCache } = require('../services/cache');

const router = express.Router();

const VALID_LOAN_STATUSES = new Set(['pending', 'inprocess', 'sanctioned', 'rejected']);

// Internal files that should never be exposed to a banker, regardless of view.
const EXCLUDED_FILENAMES = new Set(['student_meta.json', 'eligibility_report.pdf']);

// PUT /api/students/banker-access — staff only (superadmin/advisor)
// Body: { studentName, studentIdentifier, bankerName, grant: boolean }
router.put('/banker-access', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName, studentIdentifier, bankerName, grant } = req.body;
    if (!studentName || !bankerName) {
      return res.status(400).json({ success: false, error: 'Missing studentName or bankerName' });
    }

    const folderKey = sanitize(buildFolderKey(studentName, studentIdentifier || ''));
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) {
      return res.json({ success: false, error: `Student folder "${folderKey}" not found in Drive` });
    }

    const { meta } = await readStudentMeta(stuDir.id);
    const current = new Set(meta.sharedBankers || []);
    if (grant) current.add(bankerName);
    else current.delete(bankerName);
    meta.sharedBankers = Array.from(current);

    await writeStudentMeta(stuDir.id, meta);
    res.json({ success: true, sharedBankers: meta.sharedBankers });
  } catch (err) {
    console.error('bankerAccess error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/students/:studentKey/files — staff (any) or a banker who has been
// granted access to this specific student. Returns documents grouped by
// section, excluding internal-only files.
router.get('/:studentKey/files', verifyJWT, async (req, res) => {
  try {
    const folderKey = sanitize(req.params.studentKey);
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) {
      return res.json({ success: false, error: 'Student folder not found' });
    }

    if (req.admin.role === 'banker') {
      const { meta } = await readStudentMeta(stuDir.id);
      const shared = new Set(meta.sharedBankers || []);
      if (!shared.has(req.admin.name)) {
        return res.status(403).json({ success: false, error: 'You do not have access to this student' });
      }
    }

    const allFiles = await listAllFilesRecursive(stuDir.id);
    const visible = allFiles.filter((f) => !EXCLUDED_FILENAMES.has(f.name.toLowerCase()));

    const groups = {};
    for (const f of visible) {
      const group = f.relativePath || 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group].push({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size });
    }

    res.json({ success: true, groups });
  } catch (err) {
    console.error('studentFiles error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/students/:studentKey/loan-status
// All authenticated roles. Bankers may only update students they have access to.
router.put('/:studentKey/loan-status', verifyJWT, async (req, res) => {
  try {
    const { loanStatus, loanRemark = '' } = req.body;

    if (!VALID_LOAN_STATUSES.has(loanStatus)) {
      return res.status(400).json({ success: false, error: `Invalid loanStatus. Must be one of: ${[...VALID_LOAN_STATUSES].join(', ')}` });
    }
    if (loanStatus === 'rejected' && !String(loanRemark).trim()) {
      return res.status(400).json({ success: false, error: 'loanRemark is required when status is rejected' });
    }

    const folderKey = sanitize(req.params.studentKey);
    const stuDir = await findFolderByName(ROOT_FOLDER_ID(), folderKey);
    if (!stuDir) {
      return res.status(404).json({ success: false, error: `Student folder "${folderKey}" not found` });
    }

    const { meta } = await readStudentMeta(stuDir.id);

    // Bankers may only update students they have been granted access to
    if (req.admin.role === 'banker') {
      const shared = new Set(meta.sharedBankers || []);
      if (!shared.has(req.admin.name)) {
        return res.status(403).json({ success: false, error: 'You do not have access to this student' });
      }
    }

    meta.loanStatus = loanStatus;
    meta.loanRemark = loanStatus === 'rejected' ? String(loanRemark).trim() : '';
    meta.loanStatusUpdatedBy = req.admin.name;
    meta.loanStatusUpdatedAt = new Date().toISOString();

    await writeStudentMeta(stuDir.id, meta);
    studentsCache.clear();

    res.json({ success: true, loanStatus: meta.loanStatus, loanRemark: meta.loanRemark });
  } catch (err) {
    console.error('loanStatus update error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
