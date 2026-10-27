const express = require('express');
const archiver = require('archiver');
const multer = require('multer');
const {
  sanitize, buildFolderKey,
} = require('../services/drive');
const {
  resolveStudent, readMeta, updateMeta,
} = require('../services/studentStore');
const { verifyJWT, verifyJWTOrTicket, requireStaff, requireCompanyAdmin, scopedUpload } = require('../middleware/auth');
const { saveSanctionLetter, letterType } = require('../services/sanctionLetter');
const { canSeeStudent, staffStudent } = require('../services/access');
const { visibleFiles, fileBytes } = require('../services/studentFiles');
const { findByName } = require('../services/accounts');
const { canAccessOrg, ownerOrgId } = require('../services/tenantScope');

// A request (or lender) is visible to the caller only inside their companies.
async function requestVisible(r) {
  return canAccessOrg(r.orgId || (await ownerOrgId()));
}

// The lender must be an active lender of the student's own company.
async function lenderOf(ref, bankerName) {
  const lender = await findByName(bankerName);
  return lender && lender.role === 'banker' && lender.status === 'active' && lender.orgId === ref.orgId ? lender : null;
}
const { issueTicket } = require('../services/fileTickets');
const { studentsCache } = require('../services/cache');
const { logAudit } = require('../services/auditLog');
const {
  createRequest: createBankerAccessRequest,
  decideRequest: decideBankerAccessRequest,
  listRequests: listBankerAccessRequests,
} = require('../services/bankerAccessRequests');

const router = express.Router();

const VALID_LOAN_STATUSES = new Set(['pending', 'inprocess', 'sanctioned', 'rejected', 'dropped', 'disbursed']);
// Statuses that must carry an explanatory remark
const REMARK_REQUIRED_STATUSES = new Set(['rejected', 'dropped']);

// Disbursement figures that must be recorded when a loan moves to "disbursed" —
// mirrors DISBURSEMENT_FIELDS in the frontend loan status modals.
const DISBURSEMENT_FIELDS = ['processingFee', 'interestRate', 'loanAmount', 'tenureMonths', 'insuranceAmount'];

function validateDisbursement(disbursement) {
  if (!disbursement || typeof disbursement !== 'object') {
    return { error: `disbursement details are required when status is disbursed (expected: ${DISBURSEMENT_FIELDS.join(', ')})` };
  }
  const values = {};
  for (const field of DISBURSEMENT_FIELDS) {
    const n = Number(disbursement[field]);
    if (disbursement[field] === undefined || disbursement[field] === '' || Number.isNaN(n) || n < 0) {
      return { error: `disbursement.${field} must be a non-negative number` };
    }
    values[field] = n;
  }
  return { values };
}

const bankerHasAccess = (meta, bankerName) => new Set(meta.sharedBankers || []).has(bankerName);

// PUT /api/students/banker-access — staff only (superadmin/admin/advisor)
// Body: { studentName, studentIdentifier, bankerName, grant: boolean }
//
// Superadmins and company admins grant/revoke immediately. Advisors can still
// revoke immediately (removing exposure needs no review) but a NEW grant from
// an advisor is only a *request* — it lands in the pending queue for a
// superadmin to approve, and student.sharedBankers is left untouched until
// then. See services/bankerAccessRequests.js.
router.put('/banker-access', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { studentName, studentIdentifier, bankerName, grant } = req.body;
    if (!studentName || !bankerName) {
      return res.status(400).json({ success: false, error: 'Missing studentName or bankerName' });
    }

    const folderKey = sanitize(buildFolderKey(studentName, studentIdentifier || ''));
    let ref;
    try {
      ref = await staffStudent(req.admin, folderKey);
    } catch {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }
    if (grant && !(await lenderOf(ref, bankerName))) {
      return res.status(400).json({ success: false, error: 'That lender is not part of this student’s company' });
    }

    if (grant && req.admin.role === 'advisor') {
      const meta = await readMeta(ref);
      if ((meta.sharedBankers || []).includes(bankerName)) {
        return res.json({ success: true, alreadyShared: true, sharedBankers: meta.sharedBankers });
      }
      const { request, created } = await createBankerAccessRequest({
        orgId: ref.orgId, studentKey: folderKey, studentName, studentIdentifier: studentIdentifier || '', bankerName,
        requestedBy: req.admin.name, requestedByRole: req.admin.role,
      });
      if (created) {
        logAudit({
          actor: req.admin.name, role: req.admin.role, action: 'banker_access.request',
          target: folderKey, details: { banker: bankerName, requestId: request.id },
        });
      }
      return res.json({ success: true, pending: true, request });
    }

    const meta = await updateMeta(ref, (m) => {
      const current = new Set(m.sharedBankers || []);
      if (grant) current.add(bankerName);
      else current.delete(bankerName);
      m.sharedBankers = Array.from(current);
    });
    studentsCache.clear();
    logAudit({
      actor: req.admin.name, role: req.admin.role,
      action: grant ? 'banker_access.grant' : 'banker_access.revoke',
      target: folderKey, details: { banker: bankerName },
    });
    res.json({ success: true, sharedBankers: meta.sharedBankers });
  } catch (err) {
    console.error('bankerAccess error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/students/banker-access-requests — superadmin sees every request
// (optionally filtered by ?status=pending|approved|rejected); an advisor
// only ever sees their own, so they can tell what's still awaiting review.
router.get('/banker-access-requests', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { status } = req.query;
    let requests = await listBankerAccessRequests();
    const visible = await Promise.all(requests.map(requestVisible));
    requests = requests.filter((_, i) => visible[i]);
    if (req.admin.role === 'advisor') {
      requests = requests.filter((r) => r.requestedBy === req.admin.name);
    }
    if (status) requests = requests.filter((r) => r.status === status);
    requests = requests.slice().reverse(); // newest first
    res.json({ success: true, requests });
  } catch (err) {
    console.error('bankerAccessRequests list error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/students/banker-access-requests/:id/approve — superadmin, or the
// admin of the student's company.
// Applies the grant the advisor asked for, exactly like the direct-grant
// path above, then marks the request approved.
router.post('/banker-access-requests/:id/approve', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const { request, error } = await decideBankerAccessRequest(req.params.id, {
      approve: true, decidedBy: req.admin.name, visible: requestVisible,
    });
    if (error === 'not_found') return res.status(404).json({ success: false, error: 'Request not found' });
    if (error === 'already_decided') {
      return res.status(409).json({ success: false, error: `Request has already been ${request.status}` });
    }

    const ref = await resolveStudent(request.studentKey);
    if (!ref) {
      return res.status(404).json({ success: false, error: 'Student not found — the request could not be applied' });
    }

    const meta = await updateMeta(ref, (m) => {
      const current = new Set(m.sharedBankers || []);
      current.add(request.bankerName);
      m.sharedBankers = Array.from(current);
    });
    studentsCache.clear();

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'banker_access.approve',
      target: request.studentKey, details: { banker: request.bankerName, requestedBy: request.requestedBy, requestId: request.id },
    });

    res.json({ success: true, request, sharedBankers: meta.sharedBankers });
  } catch (err) {
    console.error('bankerAccessRequest approve error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/students/banker-access-requests/:id/reject — superadmin, or the
// admin of the student's company.
// Body (optional): { note } — shown to the advisor as the reason.
router.post('/banker-access-requests/:id/reject', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const { note } = req.body || {};
    const { request, error } = await decideBankerAccessRequest(req.params.id, {
      approve: false, decidedBy: req.admin.name, note, visible: requestVisible,
    });
    if (error === 'not_found') return res.status(404).json({ success: false, error: 'Request not found' });
    if (error === 'already_decided') {
      return res.status(409).json({ success: false, error: `Request has already been ${request.status}` });
    }

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'banker_access.reject',
      target: request.studentKey, details: { banker: request.bankerName, requestedBy: request.requestedBy, requestId: request.id, note: note || null },
    });

    res.json({ success: true, request });
  } catch (err) {
    console.error('bankerAccessRequest reject error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/students/:studentKey/files — staff (any) or a banker who has been
// granted access to this specific student. Returns documents grouped by
// section, excluding internal-only files.
router.get('/:studentKey/files', verifyJWT, async (req, res) => {
  try {
    const ref = await resolveStudent(req.params.studentKey);
    if (!ref) {
      return res.json({ success: false, error: 'Student not found' });
    }

    if (!(await canSeeStudent(req.admin, ref))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    }

    const visible = await visibleFiles(ref);

    const groups = {};
    for (const f of visible) {
      const group = f.group || 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group].push({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size });
    }

    res.json({ success: true, groups });
  } catch (err) {
    console.error('studentFiles error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/students/:studentKey/loan-status
// All authenticated roles. Bankers may only update students they have access to.
router.put('/:studentKey/loan-status', verifyJWT, async (req, res) => {
  try {
    const { loanStatus, loanRemark = '', disbursement } = req.body;

    if (!VALID_LOAN_STATUSES.has(loanStatus)) {
      return res.status(400).json({ success: false, error: `Invalid loanStatus. Must be one of: ${[...VALID_LOAN_STATUSES].join(', ')}` });
    }
    if (REMARK_REQUIRED_STATUSES.has(loanStatus) && !String(loanRemark).trim()) {
      return res.status(400).json({ success: false, error: `loanRemark is required when status is ${loanStatus}` });
    }
    let disbursementValues = null;
    if (loanStatus === 'disbursed') {
      const { values, error } = validateDisbursement(disbursement);
      if (error) return res.status(400).json({ success: false, error });
      disbursementValues = values;
    }

    const folderKey = sanitize(req.params.studentKey);
    const ref = await resolveStudent(folderKey);
    if (!ref) {
      return res.status(404).json({ success: false, error: `Student "${folderKey}" not found` });
    }

    if (!(await canSeeStudent(req.admin, ref))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    }

    const ACCESS_DENIED = Symbol('access denied');
    let previousStatus = null;
    const meta = await updateMeta(ref, (m) => {
      // Bankers may only update students they have been granted access to.
      // Checked inside the update so a revoke can't slip in between.
      if (req.admin.role === 'banker' && !bankerHasAccess(m, req.admin.name)) throw ACCESS_DENIED;
      previousStatus = m.loanStatus || 'pending';
      m.loanStatus = loanStatus;
      m.loanRemark = REMARK_REQUIRED_STATUSES.has(loanStatus) ? String(loanRemark).trim() : '';
      m.loanStatusUpdatedBy = req.admin.name;
      m.loanStatusUpdatedAt = new Date().toISOString();
      // Only overwritten when a new disbursal is recorded — an older disbursement
      // record is left in place if the status is later moved off "disbursed",
      // so it still shows as history rather than disappearing.
      if (disbursementValues) m.loanDisbursement = disbursementValues;
    }).catch((err) => {
      if (err === ACCESS_DENIED) return null;
      throw err;
    });
    if (!meta) {
      return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    }
    studentsCache.clear();

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'loan_status.update', target: folderKey,
      // previousStatus lets the activity views show "from → to"
      details: {
        loanStatus, previousStatus,
        ...(meta.loanRemark ? { remark: meta.loanRemark } : {}),
        ...(disbursementValues ? { disbursement: disbursementValues } : {}),
      },
    });

    res.json({ success: true, loanStatus: meta.loanStatus, loanRemark: meta.loanRemark, loanDisbursement: meta.loanDisbursement || null });
  } catch (err) {
    console.error('loanStatus update error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/students/:studentKey/sanction-letter — the lender's sanction
// letter (PDF, JPG or PNG; form field "file"). Staff who can see the student,
// or a lender the student is shared with. Replaces any earlier letter and
// records it on the student, so staff see it's in and the student can
// download it.
const letterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
router.post('/:studentKey/sanction-letter', verifyJWT, scopedUpload(letterUpload.single('file')), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Choose the sanction letter to upload' });
    if (!letterType(req.file)) {
      return res.status(400).json({ success: false, error: 'The sanction letter must be a PDF, JPG or PNG file.' });
    }

    const folderKey = sanitize(req.params.studentKey);
    const ref = await resolveStudent(folderKey);
    if (!ref) return res.status(404).json({ success: false, error: `Student "${folderKey}" not found` });
    if (!(await canSeeStudent(req.admin, ref))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    }
    // A lender only for students shared with them — checked before the file
    // is stored, and again when the record is written.
    if (req.admin.role === 'banker' && !bankerHasAccess(await readMeta(ref), req.admin.name)) {
      return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    }

    const saved = await saveSanctionLetter(ref, req.file, req.admin.name);
    const sanctionLetter = {
      fileId: saved.fileId, name: saved.name, uploadedBy: req.admin.name, uploadedAt: new Date().toISOString(),
    };
    const ACCESS_DENIED = Symbol('access denied');
    const meta = await updateMeta(ref, (m) => {
      if (req.admin.role === 'banker' && !bankerHasAccess(m, req.admin.name)) throw ACCESS_DENIED;
      m.sanctionLetter = sanctionLetter;
    }).catch((err) => {
      if (err === ACCESS_DENIED) return null;
      throw err;
    });
    if (!meta) return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    studentsCache.clear();

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'sanction_letter.upload', target: folderKey,
      details: { fileName: saved.name, loanStatus: meta.loanStatus || 'pending' },
    });
    res.json({ success: true, sanctionLetter });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('sanctionLetter upload error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/students/:studentKey/files/zip-link — a one-time link (valid 2
// minutes, this student's zip only) for the browser to download from.
// Access is checked when the link is used.
router.post('/:studentKey/files/zip-link', verifyJWT, (req, res) => {
  const ticket = issueTicket({ kind: 'zip', target: req.params.studentKey, admin: req.admin });
  res.json({
    success: true,
    url: `/api/students/${encodeURIComponent(req.params.studentKey)}/files/zip?ticket=${encodeURIComponent(ticket)}`,
  });
});

// GET /api/students/:studentKey/files/zip — download all visible docs as a zip
// Same access rules as the files listing endpoint. Opened with a one-time
// link from zip-link above (or the Authorization header).
router.get('/:studentKey/files/zip', verifyJWTOrTicket('zip', (req) => req.params.studentKey), async (req, res) => {
  try {
    const folderKey = sanitize(req.params.studentKey);
    const ref = await resolveStudent(folderKey);
    if (!ref) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    if (!(await canSeeStudent(req.admin, ref))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this student' });
    }

    const visible = await visibleFiles(ref);

    if (visible.length === 0) {
      return res.status(404).json({ success: false, error: 'No documents found' });
    }

    logAudit({
      actor: req.admin.name, role: req.admin.role, action: 'document.download_all',
      target: ref.key, details: { files: visible.length },
    });

    const safeFolderKey = folderKey.replace(/[^a-zA-Z0-9_\-.]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFolderKey}_documents.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      console.error('archiver error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);

    // Fetch and append each file; skip individual failures so one bad file
    // doesn't abort the whole zip.
    for (const f of visible) {
      try {
        const buf = await fileBytes(ref, f);
        const entryPath = f.group ? `${f.group}/${f.name}` : f.name;
        archive.append(buf, { name: entryPath });
      } catch (fileErr) {
        console.warn(`zip: skipping "${f.name}" — ${fileErr.message}`);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('filesZip error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
