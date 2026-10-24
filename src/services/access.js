// Can this signed-in account see this student?
//
// The company scope (services/tenantScope.js) already keeps everyone inside
// their own company; this adds the per-student rule within it:
//   superadmin, admin → every student in scope
//   advisor (staff)   → students assigned to them
//   banker (lender)   → students shared with them

const { readMeta, resolveStudent, resolveOrCreateStudent } = require('./studentStore');

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function canSeeMeta(admin, meta = {}) {
  if (!admin) return false;
  if (admin.role === 'superadmin' || admin.role === 'admin') return true;
  if (admin.role === 'advisor') return same(meta.advisor, admin.name);
  if (admin.role === 'banker') return (meta.sharedBankers || []).includes(admin.name);
  return false;
}

async function canSeeStudent(admin, ref) {
  if (!ref) return false;
  if (admin?.role === 'superadmin' || admin?.role === 'admin') return true;
  return canSeeMeta(admin, await readMeta(ref).catch(() => ({})));
}

class AccessError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Resolve a student key for a staff route, or throw an AccessError (404 when
// the student isn't visible, so outsiders can't probe which keys exist).
// create: true lets staff start a brand-new student record, as before.
async function staffStudent(admin, rawKey, { create = false } = {}) {
  const existing = await resolveStudent(rawKey);
  if (existing) {
    if (!(await canSeeStudent(admin, existing))) throw new AccessError('Student not found', 404);
    return existing;
  }
  if (!create || admin?.role === 'banker') throw new AccessError('Student not found', 404);
  return resolveOrCreateStudent(rawKey);
}

module.exports = { canSeeMeta, canSeeStudent, staffStudent, AccessError };
