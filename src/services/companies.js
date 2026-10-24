// Companies (organizations): Flyurdream is the owner; every partner agency
// is its own company with its own admins, staff, lenders and students.

const { query, withTransaction } = require('../db');
const { hashPassword } = require('./admins');
const { forgetCompanyCache } = require('./tenantScope');
const { AccountError, isValidEmail, normalizeEmail, passwordProblem, findByEmail, findByName, forgetAuth } = require('./accounts');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const RESERVED_SLUGS = new Set(['flyurdream', 'admin', 'api', 'portal', 'login', 'c', 'www', 'doclocker']);
const HEX_RE = /^#[0-9a-f]{6}$/i;

// Columns for everything but the logo bytes themselves.
const COMPANY_COLUMNS = 'o.id, o.slug, o.name, o.kind, o.status, o.contact_email, o.branding, o.created_at, o.logo_updated_at';

// Public, versioned URL of a company's logo (served by routes/companies.js).
function logoUrlFor(slug, updatedAt) {
  return updatedAt ? `/api/companies/public/${slug}/logo?v=${new Date(updatedAt).getTime()}` : null;
}

const MAX_LOGO_BYTES = 1024 * 1024;
// Detected from the file's own bytes, never from its name or the browser's
// type. SVG is refused: it can carry script.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Branding is shown on public pages, so only known, safe fields are kept.
function cleanBranding(input = {}) {
  const out = {};
  if (input.displayName) out.displayName = String(input.displayName).trim().slice(0, 80);
  if (input.tagline) out.tagline = String(input.tagline).trim().slice(0, 120);
  if (input.accent && HEX_RE.test(input.accent)) out.accent = input.accent.toLowerCase();
  return out;
}

function toCompany(r) {
  return {
    id: r.id, slug: r.slug, name: r.name, kind: r.kind, status: r.status,
    contactEmail: r.contact_email || '', branding: r.branding || {}, createdAt: r.created_at,
    logoUrl: logoUrlFor(r.slug, r.logo_updated_at),
    counts: r.students === undefined ? undefined : {
      students: r.students, admins: r.admins, staff: r.staff, lenders: r.lenders,
    },
  };
}

async function listCompanies() {
  const { rows } = await query(
    `SELECT ${COMPANY_COLUMNS},
       (SELECT count(*)::int FROM students s WHERE s.org_id = o.id) AS students,
       (SELECT count(*)::int FROM accounts a WHERE a.org_id = o.id AND a.role IN ('admin', 'superadmin')) AS admins,
       (SELECT count(*)::int FROM accounts a WHERE a.org_id = o.id AND a.role = 'advisor') AS staff,
       (SELECT count(*)::int FROM accounts a WHERE a.org_id = o.id AND a.role = 'banker') AS lenders
       FROM organizations o
      ORDER BY (o.kind = 'owner') DESC, lower(o.name)`,
  );
  return rows.map(toCompany);
}

async function getCompany(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await query(`SELECT ${COMPANY_COLUMNS} FROM organizations o WHERE o.id = $1`, [id]);
  return rows[0] ? toCompany(rows[0]) : null;
}

// A new company always starts with its first admin, so it is never ownerless.
async function createCompany({ name, slug, contactEmail, branding, admin }, { createdBy } = {}) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 80) throw new AccountError('Enter a company name between 2 and 80 characters');
  const cleanSlug = (slug ? String(slug).trim().toLowerCase() : slugify(cleanName));
  if (!SLUG_RE.test(cleanSlug)) throw new AccountError('Link name may use lowercase letters, numbers and dashes (2–41 characters)');
  if (RESERVED_SLUGS.has(cleanSlug)) throw new AccountError('That link name is reserved — choose another');
  if (contactEmail && !isValidEmail(contactEmail)) throw new AccountError('Enter a valid contact email');

  const adminName = String(admin?.name || '').trim().replace(/\s+/g, ' ');
  if (adminName.length < 2 || adminName.includes('__')) throw new AccountError('Enter the company admin’s name');
  if (!isValidEmail(admin?.email)) throw new AccountError('Enter the company admin’s email');
  const problem = passwordProblem(admin?.password);
  if (problem) throw new AccountError(problem);
  if (await findByEmail(admin.email)) throw new AccountError('An account with this email already exists', 409);
  if (await findByName(adminName)) throw new AccountError('An account with this name already exists', 409);

  const passwordHash = await hashPassword(admin.password);
  const id = await withTransaction(async (client) => {
    const taken = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [cleanSlug]);
    if (taken.rowCount) throw new AccountError('That link name is already used by another company', 409);
    const { rows } = await client.query(
      `INSERT INTO organizations (slug, name, kind, contact_email, branding)
       VALUES ($1, $2, 'partner', $3, $4) RETURNING id`,
      [cleanSlug, cleanName, contactEmail ? normalizeEmail(contactEmail) : null, cleanBranding(branding)],
    );
    await client.query(
      `INSERT INTO accounts (org_id, name, email, role, password_hash, created_by)
       VALUES ($1, $2, $3, 'admin', $4, $5)`,
      [rows[0].id, adminName, normalizeEmail(admin.email), passwordHash, createdBy || null],
    );
    return rows[0].id;
  });
  forgetCompanyCache();
  return getCompany(id);
}

async function updateCompany(id, { name, contactEmail, branding, status }) {
  const current = await getCompany(id);
  if (!current) throw new AccountError('Company not found', 404);
  const sets = [];
  const params = [id];
  const add = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };
  if (name !== undefined) {
    const clean = String(name).trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 80) throw new AccountError('Enter a company name between 2 and 80 characters');
    add('name', clean);
  }
  if (contactEmail !== undefined) {
    if (contactEmail && !isValidEmail(contactEmail)) throw new AccountError('Enter a valid contact email');
    add('contact_email', contactEmail ? normalizeEmail(contactEmail) : null);
  }
  if (branding !== undefined) add('branding', cleanBranding(branding));
  if (status !== undefined) {
    if (current.kind === 'owner') throw new AccountError('Flyurdream can’t be suspended');
    if (!['active', 'suspended'].includes(status)) throw new AccountError('Unknown status');
    add('status', status);
  }
  if (sets.length) await query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, params);
  forgetCompanyCache();
  forgetAuth(); // suspension must reach every signed-in member at once
  return getCompany(id);
}

async function setLogo(id, buffer) {
  if (!buffer || !buffer.length) throw new AccountError('Choose an image to upload');
  if (buffer.length > MAX_LOGO_BYTES) throw new AccountError('The logo must be 1 MB or smaller');
  const mime = sniffImage(buffer);
  if (!mime) throw new AccountError('Upload a PNG, JPG or WebP image');
  const { rowCount } = await query(
    'UPDATE organizations SET logo_data = $2, logo_mime = $3, logo_updated_at = now() WHERE id = $1',
    [id, buffer, mime],
  );
  if (!rowCount) throw new AccountError('Company not found', 404);
  forgetCompanyCache();
  forgetAuth();
  return getCompany(id);
}

async function clearLogo(id) {
  await query('UPDATE organizations SET logo_data = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = $1', [id]);
  forgetCompanyCache();
  forgetAuth();
  return getCompany(id);
}

// Logo bytes for the public URL — active companies only.
async function getLogoBySlug(slug) {
  const { rows } = await query(
    "SELECT logo_data, logo_mime, logo_updated_at FROM organizations WHERE slug = $1 AND status = 'active' AND logo_data IS NOT NULL",
    [String(slug || '').toLowerCase()],
  );
  return rows[0] ? { buffer: rows[0].logo_data, mime: rows[0].logo_mime, updatedAt: rows[0].logo_updated_at } : null;
}

// What a public page may know about a company (signup link, resume).
function publicCompany(org) {
  return { slug: org.slug, name: org.name, kind: org.kind, branding: org.branding || {}, logoUrl: logoUrlFor(org.slug, org.logo_updated_at) };
}

module.exports = {
  listCompanies, getCompany, createCompany, updateCompany, slugify, publicCompany,
  setLogo, clearLogo, getLogoBySlug, logoUrlFor, MAX_LOGO_BYTES,
};
