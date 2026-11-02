// Consultancies: each company's list of the education consultants its
// students come through, and the requests staff send to add a new one.
// Students keep the consultancy as text (personalInfo.consultantNameLoc);
// this list is the clean version those names are matched against.
const { query, withTransaction } = require('../db');
const { isRailwayStorageReady } = require('../db/startup');
const { resolveStudent, updateMeta } = require('./studentStore');

const unavailable = () => Object.assign(new Error('Consultancies need DocLocker storage, which is not available right now'), { status: 503 });
const ensureReady = () => { if (!isRailwayStorageReady()) throw unavailable(); };

// ── Names ────────────────────────────────────────────────────────────────────
// "ABC Overseas Pvt. Ltd., Hyd" and "abc overseas  - hyderabad" are one
// consultancy. Two levels:
//   nameKey(): punctuation and case only. Two names with the same key are
//              the same consultancy, full stop (the table's unique key).
//   coreTokens(): also drops company-type words and expands city short
//              forms; only used to score how alike two names are.
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const FILLER = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'the', 'and', 'co', 'company', 'group',
  'consultancy', 'consultancies', 'consultant', 'consultants', 'consulting', 'services', 'service',
  'overseas', 'education', 'educational', 'edu', 'abroad', 'study', 'studies', 'international', 'intl',
  'global', 'solutions', 'solution', 'academy', 'institute', 'careers', 'career', 'immigration', 'visa', 'visas',
  'branch', 'office',
]);
const CITY = {
  hyd: 'hyderabad', hyderbad: 'hyderabad', secbad: 'secunderabad', blr: 'bengaluru', bangalore: 'bengaluru',
  bengaluru: 'bengaluru', vizag: 'visakhapatnam', vsp: 'visakhapatnam', bza: 'vijayawada', vja: 'vijayawada',
  chennai: 'chennai', madras: 'chennai', bombay: 'mumbai', mum: 'mumbai', del: 'delhi', ndls: 'delhi', pune: 'pune',
  kkd: 'kakinada', wgl: 'warangal', gnt: 'guntur', tpt: 'tirupati',
};
function coreTokens(name) {
  return nameKey(name).split(' ').filter(Boolean).map((t) => CITY[t] || t).filter((t) => !FILLER.has(t));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0..1, how likely two names are the same consultancy
function similarity(a, b) {
  if (nameKey(a) === nameKey(b)) return 1;
  const ta = coreTokens(a);
  const tb = coreTokens(b);
  if (!ta.length || !tb.length) return 0;
  const A = new Set(ta);
  const B = new Set(tb);
  const shared = [...A].filter((t) => B.has(t)).length;
  const jaccard = shared / new Set([...A, ...B]).size;
  const ca = ta.join('');
  const cb = tb.join('');
  const edit = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  // One name inside the other ("ABC" / "ABC Hyderabad"): close, not certain
  const contains = (ca.length >= 3 && cb.length >= 3 && (ca.includes(cb) || cb.includes(ca))) ? 0.82 : 0;
  return Math.round(Math.max(jaccard, edit, contains) * 100) / 100;
}

const DUPLICATE = 0.85; // treated as the same consultancy
const SIMILAR = 0.65;   // worth a second look

// The listed consultancies a name most likely is, best first
function matchesFor(name, list) {
  return list
    .map((c) => {
      const names = [c.name, ...(c.aliases || [])];
      const score = Math.max(...names.map((n) => similarity(name, n)));
      return { id: c.id, name: c.name, score };
    })
    .filter((m) => m.score >= SIMILAR)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ── List ─────────────────────────────────────────────────────────────────────
const toConsultancy = (r) => ({
  id: r.id, name: r.name, aliases: r.aliases || [], city: r.city || '', contactPerson: r.contact_person || '',
  phone: r.phone || '', email: r.email || '', createdBy: r.created_by || '',
  createdAt: r.created_at?.toISOString?.() || r.created_at, updatedAt: r.updated_at?.toISOString?.() || r.updated_at,
});

async function listConsultancies(orgId) {
  ensureReady();
  const { rows } = await query('SELECT * FROM consultancies WHERE org_id = $1 ORDER BY lower(name)', [orgId]);
  return rows.map(toConsultancy);
}

// The listed consultancy this exact name (or one of its old spellings) is
async function findExact(orgId, name) {
  const key = nameKey(name);
  if (!key) return null;
  const { rows } = await query('SELECT * FROM consultancies WHERE org_id = $1', [orgId]);
  const hit = rows.find((r) => r.name_key === key || (r.aliases || []).some((a) => nameKey(a) === key));
  return hit ? toConsultancy(hit) : null;
}

const clean = (v, max = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
function details(input = {}) {
  const email = clean(input.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw Object.assign(new Error('Enter a valid email for the consultancy, or leave it blank'), { status: 400 });
  return { city: clean(input.city, 120), contactPerson: clean(input.contactPerson, 120), phone: clean(input.phone, 40), email };
}

async function createConsultancy(orgId, input, by) {
  ensureReady();
  const name = clean(input.name);
  if (!nameKey(name)) throw Object.assign(new Error('Enter the consultancy name'), { status: 400 });
  const existing = await findExact(orgId, name);
  if (existing) throw Object.assign(new Error(`"${existing.name}" is already listed`), { status: 409, existing });
  const d = details(input);
  const { rows } = await query(
    `INSERT INTO consultancies (org_id, name, name_key, city, contact_person, phone, email, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [orgId, name, nameKey(name), d.city || null, d.contactPerson || null, d.phone || null, d.email || null, by],
  );
  return toConsultancy(rows[0]);
}

async function updateConsultancy(orgId, id, input) {
  ensureReady();
  const { rows: [cur] } = await query('SELECT * FROM consultancies WHERE id = $1 AND org_id = $2', [id, orgId]);
  if (!cur) throw Object.assign(new Error('Consultancy not found'), { status: 404 });
  const name = input.name !== undefined ? clean(input.name) : cur.name;
  if (!nameKey(name)) throw Object.assign(new Error('Enter the consultancy name'), { status: 400 });
  if (nameKey(name) !== cur.name_key) {
    const clash = await findExact(orgId, name);
    if (clash && clash.id !== id) throw Object.assign(new Error(`"${clash.name}" is already listed. Merge them instead.`), { status: 409, existing: clash });
  }
  const d = details({ city: cur.city, contactPerson: cur.contact_person, phone: cur.phone, email: cur.email, ...input });
  // A rename keeps the old spelling as an alias, so students still match
  const aliases = nameKey(name) !== cur.name_key ? [...new Set([...(cur.aliases || []), cur.name])] : cur.aliases;
  const { rows } = await query(
    `UPDATE consultancies SET name = $3, name_key = $4, aliases = $5, city = $6, contact_person = $7, phone = $8, email = $9, updated_at = now()
      WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId, name, nameKey(name), aliases, d.city || null, d.contactPerson || null, d.phone || null, d.email || null],
  );
  return { consultancy: toConsultancy(rows[0]), renamedFrom: nameKey(name) !== cur.name_key ? cur.name : null };
}

async function deleteConsultancy(orgId, id) {
  ensureReady();
  const { rows } = await query('DELETE FROM consultancies WHERE id = $1 AND org_id = $2 RETURNING *', [id, orgId]);
  if (!rows[0]) throw Object.assign(new Error('Consultancy not found'), { status: 404 });
  return toConsultancy(rows[0]);
}

// Merge: the target keeps its name; the other spellings (listed or only
// typed on students) become its aliases, and listed duplicates go.
async function mergeInto(orgId, targetId, { names = [], ids = [] }) {
  ensureReady();
  return withTransaction(async (client) => {
    const { rows: [target] } = await client.query('SELECT * FROM consultancies WHERE id = $1 AND org_id = $2 FOR UPDATE', [targetId, orgId]);
    if (!target) throw Object.assign(new Error('Consultancy not found'), { status: 404 });
    const others = ids.length
      ? (await client.query('SELECT * FROM consultancies WHERE org_id = $1 AND id = ANY($2::uuid[]) AND id <> $3', [orgId, ids, targetId])).rows
      : [];
    const spellings = [...names.map((n) => clean(n)), ...others.flatMap((o) => [o.name, ...(o.aliases || [])])]
      .filter((n) => nameKey(n) && nameKey(n) !== target.name_key);
    const aliases = [...new Set([...(target.aliases || []), ...spellings])].slice(0, 100);
    if (others.length) await client.query('DELETE FROM consultancies WHERE org_id = $1 AND id = ANY($2::uuid[])', [orgId, others.map((o) => o.id)]);
    // Requests matched to a removed duplicate now point at the target
    if (others.length) {
      await client.query('UPDATE consultancy_requests SET consultancy_id = $3 WHERE org_id = $1 AND consultancy_id = ANY($2::uuid[])', [orgId, others.map((o) => o.id), targetId]);
    }
    const { rows } = await client.query('UPDATE consultancies SET aliases = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *', [targetId, orgId, aliases]);
    return { consultancy: toConsultancy(rows[0]), removed: others.map((o) => o.name) };
  });
}

// Set the consultancy on these students (their record's own field).
// Only students the caller can see are touched; the rest are reported.
async function setOnStudents(studentKeys, name, canSee) {
  const done = [];
  const skipped = [];
  for (const key of [...new Set(studentKeys)].slice(0, 500)) {
    try {
      const ref = await resolveStudent(key);
      if (!ref || !(await canSee(ref))) { skipped.push(key); continue; }
      await updateMeta(ref, (m) => {
        m.personalInfo = { ...(m.personalInfo || {}), consultantNameLoc: name };
      });
      done.push(key);
    } catch {
      skipped.push(key);
    }
  }
  return { updated: done.length, skipped: skipped.length };
}

// ── Requests ─────────────────────────────────────────────────────────────────
const toRequest = (r) => ({
  id: r.id, name: r.name, studentKey: r.student_key || '', studentName: r.student_name || '',
  requestedBy: r.requested_by, status: r.status, consultancyId: r.consultancy_id || null, note: r.note || '',
  decidedBy: r.decided_by || '', decidedAt: r.decided_at?.toISOString?.() || r.decided_at || null,
  createdAt: r.created_at?.toISOString?.() || r.created_at,
});

async function createRequest(orgId, { name, studentKey, studentName, requestedBy }) {
  ensureReady();
  const n = clean(name);
  if (!nameKey(n)) throw Object.assign(new Error('Enter the consultancy name'), { status: 400 });
  // One pending request per name per student is enough
  const { rows: dup } = await query(
    `SELECT * FROM consultancy_requests WHERE org_id = $1 AND status = 'pending' AND lower(name) = lower($2) AND coalesce(student_key, '') = coalesce($3, '') LIMIT 1`,
    [orgId, n, studentKey || null],
  );
  if (dup[0]) return toRequest(dup[0]);
  const { rows } = await query(
    `INSERT INTO consultancy_requests (org_id, name, student_key, student_name, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [orgId, n, studentKey || null, studentName || null, requestedBy],
  );
  return toRequest(rows[0]);
}

async function listRequests(orgId, { status, requestedBy } = {}) {
  ensureReady();
  const params = [orgId];
  let where = 'org_id = $1';
  if (status && status !== 'all') { params.push(status); where += ` AND status = $${params.length}`; }
  if (requestedBy) { params.push(requestedBy); where += ` AND requested_by = $${params.length}`; }
  const { rows } = await query(`SELECT * FROM consultancy_requests WHERE ${where} ORDER BY created_at DESC LIMIT 300`, params);
  return rows.map(toRequest);
}

async function getRequest(orgId, id) {
  const { rows } = await query('SELECT * FROM consultancy_requests WHERE id = $1 AND org_id = $2', [id, orgId]);
  return rows[0] ? toRequest(rows[0]) : null;
}

async function decideRequest(orgId, id, { status, consultancyId = null, note = '', decidedBy }) {
  const { rows } = await query(
    `UPDATE consultancy_requests SET status = $3, consultancy_id = $4, note = $5, decided_by = $6, decided_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING *`,
    [id, orgId, status, consultancyId, clean(note, 500) || null, decidedBy],
  );
  if (!rows[0]) throw Object.assign(new Error('This request was already decided'), { status: 409 });
  return toRequest(rows[0]);
}

module.exports = {
  nameKey, similarity, matchesFor, DUPLICATE, SIMILAR,
  listConsultancies, findExact, createConsultancy, updateConsultancy, deleteConsultancy, mergeInto, setOnStudents,
  createRequest, listRequests, getRequest, decideRequest,
};
