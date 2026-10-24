// Applicant accounts: registration, PIN sign-in and the applicant's own
// dashboard data (their documents, a zip of them, and their activity).
// See services/applicantPins.js for how PINs and sessions work.
const express = require('express');
const archiver = require('archiver');
const { sanitize, buildFolderKey } = require('../services/drive');
const { resolveStudent, resolveOrCreateStudent, readMeta, writeMeta, updateMeta } = require('../services/studentStore');
const { verifyJWT, requireStaff, studentCompany, requireApplicant } = require('../middleware/auth');
const { staffStudent } = require('../services/access');
const { mergeStudentMeta } = require('../services/protectedMeta');
const { isValidIndianMobile, isValidStudentEmail, normalizeIndianMobile } = require('../services/contactValidation');
const { parseIdentifier, locateStudent } = require('../services/studentLocator');
const { pinProblem, hasPin, setPin, checkPin, resetPin, signApplicantToken } = require('../services/applicantPins');
const { visibleFiles, fileBytes } = require('../services/studentFiles');
const { getCompany, publicCompany } = require('../services/companies');
const { findCompanyBySlug, ownerOrgId, runWithScope } = require('../services/tenantScope');
const { findByName } = require('../services/accounts');
const { studentsCache } = require('../services/cache');
const { logAudit } = require('../services/auditLog');
const { query } = require('../db');

const router = express.Router();

const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const NOT_FOUND = 'We couldn’t find an application with these details.';

// Work on a student inside their own company (a partner's student may sign
// in from the main site, whose request scope is Flyurdream's).
const inCompanyOf = (orgId, fn) => runWithScope({ orgIds: [orgId], homeOrgId: orgId }, fn);

// Audit entries are filed under the student's own company.
const auditFor = (ref, entry) => inCompanyOf(ref.orgId, () => logAudit(entry));

// What the portal works with: the stored record plus where it lives.
// Staff-side names (which lending officers have it, who changed the status)
// stay out — a save from the portal keeps those fields as stored anyway
// (services/protectedMeta.js).
function applicantRecord(ref, meta) {
  const sep = ref.key.indexOf('__');
  const record = { ...meta, name: meta.name || (sep >= 0 ? ref.key.slice(0, sep) : ref.key), studentKey: ref.key, storage: ref.kind };
  delete record.sharedBankers;
  delete record.loanStatusUpdatedBy;
  return record;
}

// The lenders the application is shared with, by bank.
async function lendersOf(meta) {
  const banks = await Promise.all((meta.sharedBankers || []).map(async (name) => ((await findByName(name).catch(() => null)) || {}).bank || ''));
  return [...new Set(banks.filter(Boolean))];
}

// The partner company a student belongs to (null for Flyurdream's own).
async function companyOf(orgId) {
  if (orgId === (await ownerOrgId())) return null;
  const org = await getCompany(orgId);
  const live = org && (await findCompanyBySlug(org.slug));
  return live ? publicCompany(live) : null;
}

async function signedIn(res, ref, version, extra = {}) {
  const meta = await inCompanyOf(ref.orgId, () => readMeta(ref)).catch(() => ({}));
  res.json({
    success: true,
    token: signApplicantToken({ orgId: ref.orgId, studentKey: ref.key, version }),
    student: applicantRecord(ref, meta),
    company: await companyOf(ref.orgId),
    lenders: await lendersOf(meta),
    ...extra,
  });
}

// The located student's storage reference, in its own company.
async function refFor(found) {
  const ref = await inCompanyOf(found.orgId, () => resolveStudent(found.studentKey));
  return ref && ref.orgId === found.orgId ? ref : null;
}

// ── Registration ───────────────────────────────────────────────────────────
// POST /api/applicant/register { name, email, phone, pin, applicationId? }
router.post('/register', studentCompany, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = normalizeIndianMobile(req.body?.phone);
    if (name.length < 2 || name.length > 80) return fail(res, 400, 'Enter your full name');
    if (!isValidStudentEmail(email)) return fail(res, 400, 'Enter a valid email address');
    if (!isValidIndianMobile(phone)) return fail(res, 400, 'Enter a valid 10-digit Indian mobile number');
    const pinError = pinProblem(req.body?.pin);
    if (pinError) return fail(res, 400, pinError);

    const where = { viaCompanyLink: req.viaCompanyLink, companyId: req.companyId };
    for (const id of [parseIdentifier(email), parseIdentifier(phone)]) {
      if (id && (await locateStudent(id, where))) {
        return fail(res, 409, 'An application already exists with this email or mobile number. Sign in to continue it.', { exists: true });
      }
    }

    const ref = await resolveOrCreateStudent(buildFolderKey(sanitize(name), email));
    const applicationId = /^DL-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(req.body?.applicationId || '')) ? req.body.applicationId : undefined;
    const existing = await readMeta(ref).catch(() => ({}));
    await writeMeta(ref, mergeStudentMeta(existing, {
      ...existing, name, email, phone, applicationId, createdAt: existing.createdAt || new Date().toISOString(),
      coApplicants: existing.coApplicants || 1, uploads: existing.uploads || {}, personalInfo: existing.personalInfo || {},
    }, 'student'));
    const version = await setPin(ref.orgId, ref.key, req.body.pin);

    studentsCache.clear();
    logAudit({ actor: name, role: 'student', action: 'student.register', target: ref.key, details: { storage: ref.kind } });
    await signedIn(res, ref, version);
  } catch (err) {
    console.error('applicant register error:', err.message);
    fail(res, err.status || 500, err.status ? err.message : 'Internal server error');
  }
});

// ── Sign-in ────────────────────────────────────────────────────────────────
// POST /api/applicant/lookup { identifier } → { found, hasPin }
router.post('/lookup', studentCompany, async (req, res) => {
  try {
    const id = parseIdentifier(req.body?.identifier);
    if (!id) return fail(res, 400, 'Enter the email or 10-digit mobile number you registered with');
    const found = await locateStudent(id, { viaCompanyLink: req.viaCompanyLink, companyId: req.companyId });
    if (!found) return res.json({ success: true, found: false });
    res.json({ success: true, found: true, hasPin: await hasPin(found.orgId, found.studentKey) });
  } catch (err) {
    console.error('applicant lookup error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

// POST /api/applicant/sign-in { identifier, pin }
router.post('/sign-in', studentCompany, async (req, res) => {
  try {
    const id = parseIdentifier(req.body?.identifier);
    if (!id) return fail(res, 400, 'Enter the email or 10-digit mobile number you registered with');
    const found = await locateStudent(id, { viaCompanyLink: req.viaCompanyLink, companyId: req.companyId });
    const ref = found && (await refFor(found));
    if (!ref) return fail(res, 404, NOT_FOUND);

    const result = await checkPin(ref.orgId, ref.key, req.body?.pin);
    if (result.noPin) return fail(res, 409, 'Create a PIN to protect your application first.', { needsPin: true });
    if (result.locked) {
      return fail(res, 423, `Too many wrong PINs. Try again in ${result.minutes} minute${result.minutes === 1 ? '' : 's'}, or ask your advisor to reset your PIN.`, { locked: true });
    }
    if (result.wrong) {
      auditFor(ref, { actor: 'applicant', role: 'student', action: 'applicant.sign_in_failed', target: ref.key, details: null });
      return fail(res, 401, `That PIN isn’t right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`, { attemptsLeft: result.attemptsLeft });
    }
    await signedIn(res, ref, result.version);
  } catch (err) {
    console.error('applicant sign-in error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

// POST /api/applicant/create-pin { identifier, pin } — only while the
// application has no PIN (older students, or after a staff reset).
router.post('/create-pin', studentCompany, async (req, res) => {
  try {
    const id = parseIdentifier(req.body?.identifier);
    if (!id) return fail(res, 400, 'Enter the email or 10-digit mobile number you registered with');
    const pinError = pinProblem(req.body?.pin);
    if (pinError) return fail(res, 400, pinError);
    const found = await locateStudent(id, { viaCompanyLink: req.viaCompanyLink, companyId: req.companyId });
    const ref = found && (await refFor(found));
    if (!ref) return fail(res, 404, NOT_FOUND);

    const version = await setPin(ref.orgId, ref.key, req.body.pin, { onlyIfUnset: true });
    if (version === null) return fail(res, 409, 'This application already has a PIN. Sign in with it, or ask your advisor to reset it.', { hasPin: true });
    auditFor(ref, { actor: 'applicant', role: 'student', action: 'applicant.pin_set', target: ref.key, details: null });
    await signedIn(res, ref, version);
  } catch (err) {
    console.error('applicant create-pin error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

// ── The signed-in applicant ────────────────────────────────────────────────
// GET /api/applicant/me — the latest record (staff may have changed the status)
router.get('/me', requireApplicant, async (req, res) => {
  try {
    const meta = await readMeta(req.studentRef);
    res.json({
      success: true,
      student: applicantRecord(req.studentRef, meta),
      company: await companyOf(req.studentRef.orgId),
      lenders: await lendersOf(meta),
    });
  } catch (err) {
    console.error('applicant me error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

// POST /api/applicant/submit — the applicant finished the guided steps.
router.post('/submit', requireApplicant, async (req, res) => {
  try {
    let first = false;
    const meta = await updateMeta(req.studentRef, (m) => {
      if (!m.applicationSubmittedAt) { m.applicationSubmittedAt = new Date().toISOString(); first = true; }
    });
    studentsCache.clear();
    if (first) {
      logAudit({ actor: meta.name || 'applicant', role: 'student', action: 'applicant.submit', target: req.studentRef.key, details: null });
    }
    res.json({ success: true, student: applicantRecord(req.studentRef, meta) });
  } catch (err) {
    console.error('applicant submit error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

// GET /api/applicant/documents → { groups: [{ group, files: [...] }] }
router.get('/documents', requireApplicant, async (req, res) => {
  try {
    const files = await visibleFiles(req.studentRef);
    const groups = new Map();
    for (const f of files) {
      const group = f.group || 'Other';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, updatedAt: f.updatedAt });
    }
    res.json({ success: true, groups: [...groups].map(([group, list]) => ({ group, files: list })) });
  } catch (err) {
    console.error('applicant documents error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

const FORCE_ATTACHMENT = /^(text\/html|text\/javascript|application\/javascript|image\/svg\+xml|application\/xhtml\+xml)/i;
const zipSafe = (s) => String(s || '').replace(/[^\w .()\-]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'file';

// GET /api/applicant/documents/:fileId?mode=download — one of their own files
router.get('/documents/:fileId', requireApplicant, async (req, res) => {
  try {
    const file = (await visibleFiles(req.studentRef)).find((f) => f.id === req.params.fileId);
    if (!file) return fail(res, 404, 'File not found');
    const buffer = await fileBytes(req.studentRef, file);
    const download = req.query.mode === 'download' || FORCE_ATTACHMENT.test(file.mimeType || '');
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${zipSafe(file.name).replace(/ /g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('applicant document error:', err.message);
    if (!res.headersSent) fail(res, 500, 'Internal server error');
  }
});

// GET /api/applicant/documents-zip?group= — all their files (or one folder)
router.get('/documents-zip', requireApplicant, async (req, res) => {
  try {
    let files = await visibleFiles(req.studentRef);
    if (req.query.group) files = files.filter((f) => (f.group || 'Other') === req.query.group);
    if (!files.length) return fail(res, 404, 'There are no documents to download yet');
    const meta = await readMeta(req.studentRef).catch(() => ({}));
    const label = zipSafe(`${meta.applicationId || 'Application'}_${req.query.group || 'documents'}`).replace(/[ /]+/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${label}.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      console.error('applicant zip error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);
    const taken = new Set();
    for (const f of files) {
      try {
        const buffer = await fileBytes(req.studentRef, f);
        if (!buffer) continue;
        const dir = String(f.group || 'Other').split('/').map(zipSafe).join('/');
        let name = `${dir}/${zipSafe(f.name)}`;
        for (let n = 2; taken.has(name); n++) name = `${dir}/${zipSafe(f.name).replace(/(\.[^.]+)?$/, ` (${n})$1`)}`;
        taken.add(name);
        archive.append(buffer, { name });
      } catch (fileErr) {
        console.warn(`applicant zip: skipping ${f.id} — ${fileErr.message}`);
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('applicant zip error:', err.message);
    if (!res.headersSent) fail(res, 500, 'Internal server error');
  }
});

// GET /api/applicant/activity — what happened on their application, in
// their words: status changes, lenders, reviews, their own uploads.
// Staff are named by role, lenders by their bank.
const ACTIVITY_ACTIONS = [
  'student.register', 'applicant.submit', 'document.upload', 'loan_status.update',
  'banker_access.grant', 'banker_access.approve', 'banker_access.revoke',
  'document.view', 'document.download', 'document.download_all',
];
router.get('/activity', requireApplicant, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, ts, actor, role, action, details FROM audit_log
        WHERE target = $1 AND (org_id = $2 OR role = 'superadmin') AND action = ANY($3::text[])
        ORDER BY ts DESC LIMIT 200`,
      [req.studentRef.key, req.studentRef.orgId, ACTIVITY_ACTIONS],
    );
    const bankOf = new Map();
    const bankFor = async (name) => {
      if (!name) return '';
      if (!bankOf.has(name)) bankOf.set(name, ((await findByName(name).catch(() => null)) || {}).bank || 'a lending partner');
      return bankOf.get(name);
    };
    const items = [];
    for (const r of rows) {
      const d = r.details || {};
      const base = { id: String(r.id), at: r.ts, action: r.action, by: r.role === 'student' ? 'you' : r.role };
      if (r.action === 'loan_status.update') items.push({ ...base, status: d.loanStatus, previousStatus: d.previousStatus || null, remark: d.remark || null });
      else if (r.action.startsWith('banker_access.')) items.push({ ...base, bank: await bankFor(d.banker) });
      else if (r.action.startsWith('document.') && r.role === 'banker') items.push({ ...base, bank: await bankFor(r.actor) });
      else if (r.action === 'document.upload') items.push({ ...base, file: d.fileName || null, section: d.subFolder || null });
      else if (!r.action.startsWith('document.')) items.push(base);
      else items.push({ ...base, reviewed: true });
    }
    res.json({ success: true, items });
  } catch (err) {
    console.error('applicant activity error:', err.message);
    fail(res, 500, 'Internal server error');
  }
});

// ── Staff ──────────────────────────────────────────────────────────────────
// GET /api/applicant/pin-status?studentKey= → { hasPin }
router.get('/pin-status', verifyJWT, requireStaff, async (req, res) => {
  try {
    const ref = await staffStudent(req.admin, String(req.query.studentKey || ''));
    res.json({ success: true, hasPin: await hasPin(ref.orgId, ref.key) });
  } catch (err) {
    fail(res, err.status || 500, err.status ? err.message : 'Internal server error');
  }
});

// POST /api/applicant/reset-pin { studentKey } — the student forgot their
// PIN: it's cleared (signing them out everywhere) and they choose a new one
// on their next visit.
router.post('/reset-pin', verifyJWT, requireStaff, async (req, res) => {
  try {
    const ref = await staffStudent(req.admin, String(req.body?.studentKey || ''));
    await resetPin(ref.orgId, ref.key);
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'applicant.pin_reset', target: ref.key, details: null });
    res.json({ success: true, hasPin: false });
  } catch (err) {
    fail(res, err.status || 500, err.status ? err.message : 'Internal server error');
  }
});

module.exports = router;
