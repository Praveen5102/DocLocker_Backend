const express = require('express');
const { verifyJWT, requireStaff, requireCompanyAdmin } = require('../middleware/auth');
const { canSeeStudent } = require('../services/access');
const { resolveStudent } = require('../services/studentStore');
const { studentsCache } = require('../services/cache');
const { logAudit } = require('../services/auditLog');
const c = require('../services/consultancies');

const router = express.Router();

// Same roles as requireCompanyAdmin
const isAdminLevel = (role) => role === 'superadmin' || role === 'admin';

// The company whose list this is: the caller's own, or the one a superadmin
// has picked (scope with exactly one company)
function orgOf(req) {
  const ids = req.tenantScope?.orgIds;
  return ids && ids.length === 1 ? ids[0] : req.admin.orgId;
}
const canSee = (req, orgId) => async (ref) => ref.orgId === orgId && canSeeStudent(req.admin, ref);
const audit = (req, action, target, details) => logAudit({ actor: req.admin.name, role: req.admin.role, action, target, details });
const fail = (res, err, label) => {
  if (err.status) return res.status(err.status).json({ success: false, error: err.message, ...(err.existing && { existing: err.existing }) });
  console.error(`${label} error:`, err.message);
  return res.status(500).json({ success: false, error: 'Internal server error' });
};

// GET /api/consultancies → { consultancies, pendingRequests }
router.get('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const [consultancies, pending] = await Promise.all([
      c.listConsultancies(orgId),
      c.listRequests(orgId, { status: 'pending', ...(isAdminLevel(req.admin.role) ? {} : { requestedBy: req.admin.name }) }),
    ]);
    res.json({ success: true, consultancies, pendingRequests: pending.length });
  } catch (err) { fail(res, err, 'consultancies list'); }
});

// POST /api/consultancies/check { name } → { exact, matches }: is this new,
// or one already listed under another spelling?
router.post('/check', verifyJWT, requireStaff, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const list = await c.listConsultancies(orgId);
    const name = String(req.body?.name || '');
    res.json({ success: true, exact: await c.findExact(orgId, name), matches: c.matchesFor(name, list) });
  } catch (err) { fail(res, err, 'consultancy check'); }
});

// POST /api/consultancies/assign { studentKey, name } — the consultancy on
// one student. A listed name is set straight away for anyone who can see
// the student; a new name is added by an admin, or becomes a request from
// staff for an admin to approve.
router.post('/assign', verifyJWT, requireStaff, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const name = String(req.body?.name || '').trim();
    const ref = await resolveStudent(String(req.body?.studentKey || ''));
    if (!ref || !(await canSee(req, orgId)(ref))) return res.status(404).json({ success: false, error: 'Student not found' });

    // Clearing it is always allowed
    if (!name) {
      await c.setOnStudents([ref.key], '', canSee(req, orgId));
      studentsCache.clear();
      audit(req, 'consultancy.assign', ref.key, { name: '' });
      return res.json({ success: true, assigned: true, name: '' });
    }
    let listed = await c.findExact(orgId, name);
    if (!listed && isAdminLevel(req.admin.role)) {
      listed = await c.createConsultancy(orgId, { name }, req.admin.name);
      audit(req, 'consultancy.create', listed.name, { via: 'student' });
    }
    if (listed) {
      await c.setOnStudents([ref.key], listed.name, canSee(req, orgId));
      studentsCache.clear();
      audit(req, 'consultancy.assign', ref.key, { name: listed.name });
      return res.json({ success: true, assigned: true, name: listed.name, consultancy: listed });
    }
    const request = await c.createRequest(orgId, {
      name, studentKey: ref.key, studentName: ref.key.split('__')[0], requestedBy: req.admin.name,
    });
    audit(req, 'consultancy.request', ref.key, { name });
    const list = await c.listConsultancies(orgId);
    res.json({ success: true, requested: true, request, matches: c.matchesFor(name, list) });
  } catch (err) { fail(res, err, 'consultancy assign'); }
});

// ── Admin: the list ──────────────────────────────────────────────────────────
router.post('/', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const created = await c.createConsultancy(orgOf(req), req.body || {}, req.admin.name);
    audit(req, 'consultancy.create', created.name, null);
    res.json({ success: true, consultancy: created });
  } catch (err) { fail(res, err, 'consultancy create'); }
});

// PUT /:id { name?, city?, contactPerson?, phone?, email?, studentKeys? } —
// a rename also updates the students listed in studentKeys
router.put('/:id', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const { consultancy, renamedFrom } = await c.updateConsultancy(orgId, req.params.id, req.body || {});
    let students = { updated: 0, skipped: 0 };
    if (renamedFrom && Array.isArray(req.body?.studentKeys)) {
      students = await c.setOnStudents(req.body.studentKeys, consultancy.name, canSee(req, orgId));
      studentsCache.clear();
    }
    audit(req, 'consultancy.update', consultancy.name, renamedFrom ? { renamedFrom, students: students.updated } : null);
    res.json({ success: true, consultancy, students });
  } catch (err) { fail(res, err, 'consultancy update'); }
});

router.delete('/:id', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const removed = await c.deleteConsultancy(orgOf(req), req.params.id);
    audit(req, 'consultancy.delete', removed.name, null);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'consultancy delete'); }
});

// POST /:id/merge { names, ids, studentKeys } — the other spellings (typed
// names and listed duplicates) become this one; the students that used them
// are updated to its name
router.post('/:id/merge', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const names = Array.isArray(req.body?.names) ? req.body.names.slice(0, 100) : [];
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100) : [];
    const { consultancy, removed } = await c.mergeInto(orgId, req.params.id, { names, ids });
    const students = await c.setOnStudents(Array.isArray(req.body?.studentKeys) ? req.body.studentKeys : [], consultancy.name, canSee(req, orgId));
    studentsCache.clear();
    audit(req, 'consultancy.merge', consultancy.name, { merged: [...names, ...removed].slice(0, 20), students: students.updated });
    res.json({ success: true, consultancy, removed, students });
  } catch (err) { fail(res, err, 'consultancy merge'); }
});

// ── Requests ─────────────────────────────────────────────────────────────────
// GET /requests?status=pending|approved|mapped|rejected|all — admins see
// every request in the company, staff their own. Each comes with the
// listed consultancies it may duplicate.
router.get('/requests', verifyJWT, requireStaff, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const [requests, list] = await Promise.all([
      c.listRequests(orgId, { status: req.query.status || 'pending', ...(isAdminLevel(req.admin.role) ? {} : { requestedBy: req.admin.name }) }),
      c.listConsultancies(orgId),
    ]);
    res.json({ success: true, requests: requests.map((r) => ({ ...r, matches: r.status === 'pending' ? c.matchesFor(r.name, list) : [] })) });
  } catch (err) { fail(res, err, 'consultancy requests'); }
});

async function pendingRequest(req, res) {
  const r = await c.getRequest(orgOf(req), req.params.id);
  if (!r) { res.status(404).json({ success: false, error: 'Request not found' }); return null; }
  if (r.status !== 'pending') { res.status(409).json({ success: false, error: 'This request was already decided' }); return null; }
  return r;
}

// POST /requests/:id/approve { name?, city?, contactPerson?, phone?, email? }
// — add it as a new consultancy (the name can be tidied first)
router.post('/requests/:id/approve', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const r = await pendingRequest(req, res);
    if (!r) return;
    const name = String(req.body?.name || r.name).trim();
    const consultancy = (await c.findExact(orgId, name)) || (await c.createConsultancy(orgId, { ...(req.body || {}), name }, req.admin.name));
    const request = await c.decideRequest(orgId, r.id, { status: 'approved', consultancyId: consultancy.id, decidedBy: req.admin.name });
    if (r.studentKey) await c.setOnStudents([r.studentKey], consultancy.name, canSee(req, orgId));
    studentsCache.clear();
    audit(req, 'consultancy.request_approve', consultancy.name, { requested: r.name, requestedBy: r.requestedBy });
    res.json({ success: true, request, consultancy });
  } catch (err) { fail(res, err, 'consultancy approve'); }
});

// POST /requests/:id/map { consultancyId } — it's one already listed: the
// requested spelling is kept as an alias, the student gets the listed name
router.post('/requests/:id/map', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const orgId = orgOf(req);
    const r = await pendingRequest(req, res);
    if (!r) return;
    const { consultancy } = await c.mergeInto(orgId, String(req.body?.consultancyId || ''), { names: [r.name] });
    const request = await c.decideRequest(orgId, r.id, { status: 'mapped', consultancyId: consultancy.id, decidedBy: req.admin.name });
    if (r.studentKey) await c.setOnStudents([r.studentKey], consultancy.name, canSee(req, orgId));
    studentsCache.clear();
    audit(req, 'consultancy.request_map', consultancy.name, { requested: r.name, requestedBy: r.requestedBy });
    res.json({ success: true, request, consultancy });
  } catch (err) { fail(res, err, 'consultancy map'); }
});

router.post('/requests/:id/reject', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const r = await pendingRequest(req, res);
    if (!r) return;
    const request = await c.decideRequest(orgOf(req), r.id, { status: 'rejected', note: req.body?.note || '', decidedBy: req.admin.name });
    audit(req, 'consultancy.request_reject', r.name, { requestedBy: r.requestedBy, ...(request.note ? { note: request.note } : {}) });
    res.json({ success: true, request });
  } catch (err) { fail(res, err, 'consultancy reject'); }
});

module.exports = router;
