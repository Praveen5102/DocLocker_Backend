// Which companies the current request may touch.
//
// Set once per request — by verifyJWT for staff (from the signed-in
// account) and by studentCompany() for the public student routes (from the
// company signup link) — and read by every data helper, so no route has to
// remember to pass a company along and no query can quietly skip the filter.
//
//   orgIds:   null  → every company (superadmin only)
//             [id]  → just these companies
//   homeOrgId        → where new students / audit rows are written
//
// Outside any request (scripts, nightly backup) there is no scope; data
// helpers then fall back to the owner organisation, which is what they did
// before companies existed.

const { AsyncLocalStorage } = require('async_hooks');
const { query } = require('../db');

const OWNER_ORG_SLUG = 'flyurdream';
const storage = new AsyncLocalStorage();

let ownerPromise = null;
function ownerOrgId() {
  if (!ownerPromise) {
    ownerPromise = query('SELECT id FROM organizations WHERE slug = $1', [OWNER_ORG_SLUG])
      .then(({ rows }) => {
        if (!rows[0]) throw new Error(`Organisation "${OWNER_ORG_SLUG}" is missing — run migrations`);
        return rows[0].id;
      })
      .catch((err) => { ownerPromise = null; throw err; });
  }
  return ownerPromise;
}

function runWithScope(scope, fn) {
  return storage.run(Object.freeze({ ...scope }), fn);
}

function currentScope() {
  return storage.getStore() || null;
}

// Org ids for a WHERE org_id = ANY($n) filter, or null for "all companies".
async function scopeOrgIds() {
  const scope = currentScope();
  if (!scope) return [await ownerOrgId()];
  return scope.orgIds ? [...scope.orgIds] : null;
}

async function homeOrgId() {
  return currentScope()?.homeOrgId || ownerOrgId();
}

// Legacy Google Drive students all belong to Flyurdream.
async function includesOwner() {
  const ids = await scopeOrgIds();
  return ids === null || ids.includes(await ownerOrgId());
}

async function canAccessOrg(orgId) {
  const ids = await scopeOrgIds();
  return ids === null || ids.includes(orgId);
}

// ── Company lookup by signup-link slug ─────────────────────────────────────
const slugCache = new Map(); // slug -> { org, expires }
const SLUG_TTL_MS = 60 * 1000;

async function findCompanyBySlug(slug) {
  const key = String(slug || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(key)) return null;
  const hit = slugCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.org;
  const { rows } = await query(
    "SELECT id, slug, name, kind, status, branding, logo_updated_at FROM organizations WHERE slug = $1",
    [key],
  );
  const org = rows[0] || null;
  slugCache.set(key, { org, expires: Date.now() + SLUG_TTL_MS });
  return org;
}

function forgetCompanyCache() {
  slugCache.clear();
}

module.exports = {
  OWNER_ORG_SLUG,
  ownerOrgId,
  runWithScope,
  currentScope,
  scopeOrgIds,
  homeOrgId,
  includesOwner,
  canAccessOrg,
  findCompanyBySlug,
  forgetCompanyCache,
};
