// Staff accounts: superadmin, company admins, advisors (staff) and lenders.
//
// Stored in Postgres (accounts table, migration 003). The old admins.json
// roster on Drive is imported once, into Flyurdream, the first time the
// table is empty — it is only ever read, never written, after that.
//
// Sign-in is by email. Accounts imported without an email can't sign in
// until a superadmin adds one — except a superadmin with no email yet, who
// may sign in by name once to set their own (see routes/auth.js).

const { query } = require('../db');
const { hashPassword, verifyPassword, readAdminsFile } = require('./admins');
const { ownerOrgId } = require('./tenantScope');

const ROLES = ['superadmin', 'admin', 'advisor', 'banker'];
const ROLE_LABELS = { superadmin: 'Super admin', admin: 'Admin', advisor: 'Staff', banker: 'Lender' };

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const AUTH_CACHE_MS = 30 * 1000;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const isValidEmail = (email) => EMAIL_RE.test(normalizeEmail(email));

// At least 10 characters with a letter and a number. Long passphrases are
// fine; the cap only guards bcrypt, which ignores bytes past 72.
function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Password must be at least 10 characters';
  if (p.length > 72) return 'Password must be at most 72 characters';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must include at least one letter and one number';
  return null;
}

const ACCOUNT_COLUMNS = `a.id, a.org_id, a.name, a.email, a.role, a.bank, a.status, a.token_version,
  a.failed_logins, a.locked_until, a.last_login_at, a.created_at, a.created_by,
  o.name AS org_name, o.slug AS org_slug, o.kind AS org_kind, o.status AS org_status,
  o.logo_updated_at AS org_logo_at`;

const logoUrl = (slug, at) => (at ? `/api/companies/public/${slug}/logo?v=${new Date(at).getTime()}` : null);

function toAccount(r) {
  if (!r) return null;
  return {
    id: r.id, orgId: r.org_id, name: r.name, email: r.email, role: r.role, bank: r.bank || '',
    status: r.status, tokenVersion: r.token_version, failedLogins: r.failed_logins,
    lockedUntil: r.locked_until, lastLoginAt: r.last_login_at, createdAt: r.created_at, createdBy: r.created_by,
    company: { id: r.org_id, name: r.org_name, slug: r.org_slug, kind: r.org_kind, status: r.org_status, logoUrl: logoUrl(r.org_slug, r.org_logo_at) },
  };
}

// What the API returns about an account — never the hash or lockout counters.
function publicAccount(a) {
  return {
    id: a.id, name: a.name, email: a.email || '', role: a.role, roleLabel: ROLE_LABELS[a.role],
    bank: a.bank || '', status: a.status, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt,
    company: { id: a.company.id, name: a.company.name, slug: a.company.slug, kind: a.company.kind, logoUrl: a.company.logoUrl || null },
  };
}

async function findOne(where, params) {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLUMNS}, a.password_hash FROM accounts a JOIN organizations o ON o.id = a.org_id WHERE ${where} LIMIT 1`,
    params,
  );
  if (!rows[0]) return null;
  return { ...toAccount(rows[0]), passwordHash: rows[0].password_hash };
}

const findByEmail = (email) => findOne('lower(a.email) = $1', [normalizeEmail(email)]);
const findById = (id) => (/^[0-9a-f-]{36}$/i.test(String(id)) ? findOne('a.id = $1', [id]) : Promise.resolve(null));
const findByName = (name) => findOne('lower(a.name) = lower($1)', [String(name || '').trim()]);

async function countAccounts() {
  const { rows } = await query('SELECT count(*)::int AS n FROM accounts');
  return rows[0].n;
}

// ── Per-request lookup (verifyJWT) ───────────────────────────────────────
const authCache = new Map(); // id -> { account, expires }

async function getAuthAccount(id) {
  const hit = authCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.account;
  const account = await findById(id);
  if (account) delete account.passwordHash;
  authCache.set(id, { account, expires: Date.now() + AUTH_CACHE_MS });
  return account;
}

function forgetAuth(id) {
  if (id) authCache.delete(id); else authCache.clear();
}

// ── Sign-in bookkeeping ──────────────────────────────────────────────────
function lockedMinutesLeft(account) {
  if (!account.lockedUntil) return 0;
  const ms = new Date(account.lockedUntil).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

async function recordFailedLogin(account) {
  await query(
    `UPDATE accounts SET
       failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
       locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1`,
    [account.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
  );
}

async function recordLogin(account, { passwordHash } = {}) {
  await query(
    `UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now()
       ${passwordHash ? ', password_hash = $2' : ''}
     WHERE id = $1`,
    passwordHash ? [account.id, passwordHash] : [account.id],
  );
}

// ── Who may manage whom ──────────────────────────────────────────────────
// superadmin → anyone (superadmins only inside Flyurdream)
// admin      → admins, staff and lenders of their own company
// advisor    → lenders of their own company (as before)
// banker     → nobody
function manageableRoles(actor) {
  if (actor.role === 'superadmin') return ['superadmin', 'admin', 'advisor', 'banker'];
  if (actor.role === 'admin') return ['admin', 'advisor', 'banker'];
  if (actor.role === 'advisor') return ['banker'];
  return [];
}

function canManage(actor, { role, orgId }) {
  if (!manageableRoles(actor).includes(role)) return false;
  return actor.role === 'superadmin' || actor.orgId === orgId;
}

// ── CRUD ─────────────────────────────────────────────────────────────────
async function listAccounts({ orgIds, roles } = {}) {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a JOIN organizations o ON o.id = a.org_id
      WHERE ($1::uuid[] IS NULL OR a.org_id = ANY($1::uuid[]))
        AND ($2::text[] IS NULL OR a.role = ANY($2::text[]))
      ORDER BY o.kind DESC, o.name, a.role, lower(a.name)`,
    [orgIds || null, roles || null],
  );
  return rows.map(toAccount);
}

class AccountError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function createAccount({ orgId, name, email, role, bank, password, createdBy }) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 80) throw new AccountError('Enter a name between 2 and 80 characters');
  if (cleanName.includes('__')) throw new AccountError('Name cannot contain "__"');
  if (!ROLES.includes(role)) throw new AccountError('Unknown role');
  if (!isValidEmail(email)) throw new AccountError('Enter a valid email address');
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  if (role === 'superadmin' && orgId !== (await ownerOrgId())) throw new AccountError('Super admins belong to Flyurdream');
  if (role === 'banker' && !String(bank || '').trim()) throw new AccountError('Select the lender’s bank');

  if (await findByEmail(email)) throw new AccountError('An account with this email already exists', 409);
  if (await findByName(cleanName)) throw new AccountError('An account with this name already exists', 409);

  const { rows } = await query(
    `INSERT INTO accounts (org_id, name, email, role, bank, password_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [orgId, cleanName, normalizeEmail(email), role, role === 'banker' ? String(bank).trim() : null,
      await hashPassword(password), createdBy || null],
  );
  return findById(rows[0].id);
}

// Changes that make old sign-ins stale bump token_version.
async function updateAccount(id, { email, bank, role, status, password }) {
  const current = await findById(id);
  if (!current) throw new AccountError('Account not found', 404);
  const sets = [];
  const params = [id];
  const add = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };
  let revoke = false;

  if (email !== undefined && normalizeEmail(email) !== (current.email || '')) {
    if (!isValidEmail(email)) throw new AccountError('Enter a valid email address');
    const other = await findByEmail(email);
    if (other && other.id !== id) throw new AccountError('Another account already uses this email', 409);
    add('email', normalizeEmail(email));
  }
  if (bank !== undefined && current.role === 'banker') add('bank', String(bank || '').trim() || null);
  if (role !== undefined && role !== current.role) {
    if (!ROLES.includes(role)) throw new AccountError('Unknown role');
    if (role === 'superadmin' && current.orgId !== (await ownerOrgId())) throw new AccountError('Super admins belong to Flyurdream');
    add('role', role);
    revoke = true;
  }
  if (status !== undefined && status !== current.status) {
    if (!['active', 'disabled'].includes(status)) throw new AccountError('Unknown status');
    add('status', status);
    revoke = true;
  }
  if (password !== undefined) {
    const problem = passwordProblem(password);
    if (problem) throw new AccountError(problem);
    add('password_hash', await hashPassword(password));
    sets.push('failed_logins = 0', 'locked_until = NULL');
    revoke = true;
  }
  if (revoke) sets.push('token_version = token_version + 1');
  if (sets.length) await query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1`, params);
  forgetAuth(id);
  return findById(id);
}

async function deleteAccount(id) {
  await query('DELETE FROM accounts WHERE id = $1', [id]);
  forgetAuth(id);
}

// The last active superadmin can't be removed, disabled or demoted.
async function isLastSuperadmin(account) {
  if (account.role !== 'superadmin') return false;
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM accounts WHERE role = 'superadmin' AND status = 'active' AND id <> $1",
    [account.id],
  );
  return rows[0].n === 0;
}

// ── One-time import of the Drive roster ──────────────────────────────────
async function importLegacyAccounts({ log = console.log } = {}) {
  if ((await countAccounts()) > 0) return 0;
  const data = await readAdminsFile();
  const legacy = Array.isArray(data?.admins) ? data.admins : [];
  if (!legacy.length) return 0;
  const orgId = await ownerOrgId();
  const seenEmails = new Set();
  let imported = 0;
  for (const a of legacy) {
    if (!a?.name || !a?.passwordHash || !ROLES.includes(a.role)) continue;
    let email = isValidEmail(a.email) ? normalizeEmail(a.email) : null;
    if (email && seenEmails.has(email)) email = null;
    if (email) seenEmails.add(email);
    const { rowCount } = await query(
      `INSERT INTO accounts (org_id, name, email, role, bank, password_hash, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'import', COALESCE($7::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [orgId, String(a.name).trim(), email, a.role, a.role === 'banker' ? (a.bank || null) : null,
        a.passwordHash, a.createdAt || null],
    );
    imported += rowCount;
  }
  log(`[accounts] imported ${imported} account(s) from admins.json into Flyurdream`);
  return imported;
}

// Many imported accounts used their email address as their login name.
// Those get it as their email, if no other account has it already.
async function backfillEmailsFromNames({ log = console.log } = {}) {
  const { rows } = await query("SELECT id, name FROM accounts WHERE email IS NULL");
  let filled = 0;
  for (const r of rows) {
    if (!isValidEmail(r.name)) continue;
    const email = normalizeEmail(r.name);
    const { rowCount } = await query(
      `UPDATE accounts SET email = $2
        WHERE id = $1 AND email IS NULL
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE lower(email) = $2)`,
      [r.id, email],
    );
    filled += rowCount;
  }
  if (filled) log(`[accounts] set ${filled} email(s) from login names that were email addresses`);
  return filled;
}

module.exports = {
  ROLES, ROLE_LABELS, AccountError,
  normalizeEmail, isValidEmail, passwordProblem,
  findByEmail, findById, findByName, countAccounts,
  getAuthAccount, forgetAuth,
  lockedMinutesLeft, recordFailedLogin, recordLogin,
  manageableRoles, canManage,
  listAccounts, createAccount, updateAccount, deleteAccount, isLastSuperadmin,
  publicAccount, verifyPassword, hashPassword,
  importLegacyAccounts, backfillEmailsFromNames,
};
