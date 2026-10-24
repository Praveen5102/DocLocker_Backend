const jwt = require('jsonwebtoken');
const { redeemTicket } = require('../services/fileTickets');
const { getAuthAccount } = require('../services/accounts');
const { runWithScope, findCompanyBySlug, ownerOrgId } = require('../services/tenantScope');
const { readApplicantToken, getPinRow } = require('../services/applicantPins');
const { query } = require('../db');

// A token only says WHO is signed in ({ sub, tv }). Role, company and status
// are read from the account on every request (cached briefly), so disabling
// someone, changing their role or suspending their company takes effect at
// once instead of when an 8-hour token runs out.

// Header a superadmin may send to look at a single company.
const COMPANY_HEADER = 'x-doclocker-company';

// Routes a "setup" token (superadmin signed in by name, no email yet) may use.
const SETUP_ALLOWED = new Set(['/api/auth/me', '/api/auth/me/email']);

async function resolveAccount(id, tokenVersion) {
  const account = await getAuthAccount(id);
  if (!account) return { error: 'Your account no longer exists' };
  if (account.tokenVersion !== tokenVersion) return { error: 'Your session has ended. Please sign in again.' };
  if (account.status !== 'active') return { error: 'This account has been disabled' };
  if (account.company.status !== 'active') return { error: 'This company’s access is suspended' };
  return { account };
}

function toAdmin(account, { setup = false } = {}) {
  return {
    id: account.id,
    tokenVersion: account.tokenVersion,
    name: account.name,
    email: account.email || '',
    role: account.role,
    orgId: account.orgId,
    company: account.company,
    bank: account.role === 'banker' ? account.bank : '',
    advisorName: account.role === 'advisor' ? account.name : '',
    setup,
  };
}

// Scope: superadmin sees every company (or one, via the header); everyone
// else only their own.
function scopeFor(admin, req) {
  if (admin.role !== 'superadmin') return { orgIds: [admin.orgId], homeOrgId: admin.orgId };
  const pick = String(req.headers[COMPANY_HEADER] || '');
  if (/^[0-9a-f-]{36}$/i.test(pick)) return { orgIds: [pick], homeOrgId: admin.orgId };
  return { orgIds: null, homeOrgId: admin.orgId };
}

// Kept on req as well: callbacks fired from stream events (multer) run
// outside the request's async context, so scopedUpload() re-enters it.
function enterScope(req, scope, next) {
  req.tenantScope = scope;
  runWithScope(scope, next);
}

function scopedUpload(middleware) {
  return (req, res, next) => middleware(req, res, (err) => {
    if (req.tenantScope) runWithScope(req.tenantScope, () => next(err));
    else next(err);
  });
}

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra });
}

function verifyJWT(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return fail(res, 401, 'No token provided');
  let claims;
  try {
    claims = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return fail(res, 401, 'Invalid or expired token');
  }
  if (!claims.sub) return fail(res, 401, 'Please sign in again');

  resolveAccount(claims.sub, claims.tv).then(({ account, error }) => {
    if (error) return fail(res, 401, error);
    if (claims.setup && !SETUP_ALLOWED.has(req.baseUrl + req.path)) {
      return fail(res, 403, 'Add your email address to finish signing in', { setupRequired: true });
    }
    req.admin = toAdmin(account, { setup: Boolean(claims.setup) });
    enterScope(req, scopeFor(req.admin, req), next);
  }).catch((err) => {
    console.error('auth lookup failed:', err.message);
    fail(res, 500, 'Internal server error');
  });
}

function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== 'superadmin') return fail(res, 403, 'Superadmin access required');
  next();
}

// Superadmin, or the admin of a company (their scope keeps them inside it).
function requireCompanyAdmin(req, res, next) {
  if (!['superadmin', 'admin'].includes(req.admin?.role)) return fail(res, 403, 'Admin access required');
  next();
}

// Blocks banker accounts from write/management endpoints — bankers are
// read-only viewers of the students they've been granted access to.
function requireStaff(req, res, next) {
  if (req.admin?.role === 'banker') return fail(res, 403, 'Not available to bank accounts');
  next();
}

// For endpoints a browser may load as a plain link (file downloads, zip).
// Accepts either the normal Authorization header (in-app fetches) or a
// one-time ticket for exactly this resource (?ticket=…, see
// services/fileTickets.js). A full login token in the URL is NOT accepted —
// a forwarded link must never hand over the account.
// targetOf(req) names the resource the ticket must have been issued for.
function verifyJWTOrTicket(kind, targetOf) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return verifyJWT(req, res, next);
    if (!req.query.ticket) return fail(res, 401, 'No token provided');
    const holder = redeemTicket(req.query.ticket, { kind, target: targetOf(req) });
    if (!holder) {
      return fail(res, 401, 'This download link has expired or was already used. Start the download again from DocLocker.');
    }
    resolveAccount(holder.id, holder.tv).then(({ account, error }) => {
      if (error) return fail(res, 401, error);
      req.admin = toAdmin(account);
      req.viaTicket = true;
      // A ticket carries the exact scope it was issued under.
      enterScope(req, holder.scope || scopeFor(req.admin, req), next);
    }).catch((err) => {
      console.error('ticket lookup failed:', err.message);
      fail(res, 500, 'Internal server error');
    });
  };
}

// Public student routes: the company comes from the signup link
// (?company= / X-DocLocker-Company: <slug>), Flyurdream when absent.
function studentCompany(req, res, next) {
  const slug = String(req.headers[COMPANY_HEADER] || req.query.company || req.body?.company || '').trim().toLowerCase();
  const pick = slug && slug !== 'flyurdream' ? findCompanyBySlug(slug) : ownerOrgId().then((id) => ({ id, status: 'active' }));
  Promise.resolve(pick).then((org) => {
    if (!org || org.status !== 'active') return fail(res, 404, 'This signup link is not active');
    req.companyId = org.id;
    // false on the main site, where a lookup may also find a partner's student
    req.viaCompanyLink = Boolean(slug && slug !== 'flyurdream');
    enterScope(req, { orgIds: [org.id], homeOrgId: org.id }, next);
  }).catch((err) => {
    console.error('company lookup failed:', err.message);
    fail(res, 500, 'Internal server error');
  });
}

// Student routes: a signed-in applicant (PIN session, see
// services/applicantPins.js). The company and the student come from the
// session — never from the request body — and a PIN reset ends it.
// Sets req.applicant = { orgId, studentKey } and req.studentRef.
function requireApplicant(req, res, next) {
  const claims = readApplicantToken(req);
  if (!claims) return fail(res, 401, 'Please sign in to your application again', { applicantSignIn: true });
  (async () => {
    const pin = await getPinRow(claims.org, claims.sk);
    if (!pin?.pin_hash || pin.pin_version !== claims.pv) return { error: 'Your session has ended. Please sign in again.' };
    const { rows } = await query('SELECT status FROM organizations WHERE id = $1', [claims.org]);
    if (rows[0]?.status !== 'active') return { error: 'This application can’t be opened right now' };
    return {};
  })().then(({ error }) => {
    if (error) return fail(res, 401, error, { applicantSignIn: true });
    req.applicant = { orgId: claims.org, studentKey: claims.sk };
    req.companyId = claims.org;
    enterScope(req, { orgIds: [claims.org], homeOrgId: claims.org }, () => {
      // Required lazily so this middleware file stays free of storage imports.
      require('../services/studentStore').resolveStudent(claims.sk).then((ref) => {
        if (!ref || ref.orgId !== claims.org) return fail(res, 401, 'Your application could not be found', { applicantSignIn: true });
        req.studentRef = ref;
        next();
      }).catch((err) => {
        console.error('applicant lookup failed:', err.message);
        fail(res, 500, 'Internal server error');
      });
    });
  }).catch((err) => {
    console.error('applicant session check failed:', err.message);
    fail(res, 500, 'Internal server error');
  });
}

module.exports = {
  verifyJWT, verifyJWTOrTicket, requireSuperAdmin, requireCompanyAdmin, requireStaff,
  studentCompany, scopedUpload, scopeFor, requireApplicant,
};
