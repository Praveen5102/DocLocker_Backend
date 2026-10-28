// One place that knows where a student lives.
//
//   - New students (registered once Railway storage is ready) live on
//     Railway: their record in Postgres (encrypted, record_enc) and their
//     documents in the bucket (encrypted, objectStore).
//   - Everyone else keeps living in Google Drive exactly as before.
//
// Routes resolve a student once with resolveStudent() and then pass the
// returned ref to the helpers here, so neither side needs to know which
// backend it is talking to. A student is only ever created on Railway when
// no Drive folder exists for them, so a returning (old) student is never
// split across the two.
//
// Every query is scoped to the companies the current request may see (see
// services/tenantScope.js). Legacy Drive students all belong to Flyurdream,
// so they are only visible when that scope includes the owner organisation.

const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { isRailwayStorageReady } = require('../db/startup');
const { encryptJson, decryptJson } = require('./dataCrypto');
const { documentKey, putEncrypted, getDecrypted, deleteObject } = require('./objectStore');
const {
  ROOT_FOLDER_ID, sanitize, findFolderByName, getOrCreate,
} = require('./drive');
const { readStudentMeta, writeStudentMeta } = require('./studentMeta');
const { ownerOrgId, scopeOrgIds, homeOrgId, includesOwner } = require('./tenantScope');

const GENERATED_FILES = ['Student_Summary.pdf', 'Eligibility_Report.pdf'];

// Public ids for Railway documents. Drive file ids never start with "rw_",
// so the file proxy can tell the two apart without a lookup.
const PUBLIC_ID_RE = /^rw_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const toPublicId = (uuid) => `rw_${uuid}`;
function parsePublicId(id) {
  const m = PUBLIC_ID_RE.exec(String(id || ''));
  return m ? m[1].toLowerCase() : null;
}
const isRailwayFileId = (id) => parsePublicId(id) !== null;

// Canonical student key — identical to the Drive folder name, which
// getOrCreate/findFolderByName always pass through sanitize().
const studentKeyOf = (raw) => sanitize(raw);

// `org_id = ANY($n)` unless the scope is every company (superadmin).
const ORG_FILTER = (n, col = 'org_id') => `($${n}::uuid[] IS NULL OR ${col} = ANY($${n}::uuid[]))`;

// Searchable columns kept beside the encrypted record. Everything else
// (addresses, ID numbers, family details, uploads…) only exists inside
// record_enc.
function indexColumns(key, meta) {
  const sep = key.indexOf('__');
  const pi = meta.personalInfo || {};
  return {
    name: String(meta.name || (sep >= 0 ? key.slice(0, sep) : key)).slice(0, 300),
    identifier: sep >= 0 ? key.slice(sep + 2) : null,
    email: meta.email || pi.email || null,
    phone: meta.phone || pi.phone || null,
    advisor: meta.advisor || null,
    consultancy: meta.consultancy || null,
    loanStatus: meta.loanStatus || 'pending',
  };
}

// ── Lookup ───────────────────────────────────────────────────────────────────

async function findRailwayRow(key) {
  if (!isRailwayStorageReady()) return null;
  const { rows } = await query(
    `SELECT id, org_id, folder_key FROM students
      WHERE ${ORG_FILTER(1)} AND folder_key = $2 AND source = 'railway'
      ORDER BY created_at LIMIT 1`,
    [await scopeOrgIds(), key],
  );
  return rows[0] || null;
}

// → { kind: 'railway', key, studentId, orgId } | { kind: 'drive', key, orgId, dir } | null
async function resolveStudent(rawKey) {
  const key = studentKeyOf(rawKey);
  const row = await findRailwayRow(key);
  if (row) return { kind: 'railway', key, studentId: row.id, orgId: row.org_id };
  if (!(await includesOwner())) return null;
  const dir = await findFolderByName(ROOT_FOLDER_ID(), key);
  return dir ? { kind: 'drive', key, orgId: await ownerOrgId(), dir } : null;
}

// Same as resolveStudent, but a student found nowhere is created — on
// Railway when it's ready, otherwise as a Drive folder (the old behaviour).
async function resolveOrCreateStudent(rawKey) {
  const found = await resolveStudent(rawKey);
  if (found) return found;
  const key = studentKeyOf(rawKey);
  const orgId = await homeOrgId();
  const isOwner = orgId === (await ownerOrgId());
  if (!isRailwayStorageReady()) {
    // Partner companies only ever live on Railway.
    if (!isOwner) throw Object.assign(new Error('Storage is not available right now'), { status: 503 });
    return { kind: 'drive', key, orgId, dir: await getOrCreate(ROOT_FOLDER_ID(), key) };
  }
  const cols = indexColumns(key, {});
  // ON CONFLICT: a double-submitted registration resolves to the one row.
  const { rows } = await query(
    `INSERT INTO students (org_id, folder_key, name, identifier, record_enc, source)
     VALUES ($1, $2, $3, $4, $5, 'railway')
     ON CONFLICT (org_id, folder_key) DO UPDATE SET folder_key = EXCLUDED.folder_key
     RETURNING id, source`,
    [orgId, key, cols.name, cols.identifier, encryptJson({})],
  );
  if (rows[0].source !== 'railway') {
    // An imported Drive student already owns this key — keep using Drive.
    return { kind: 'drive', key, orgId, dir: await getOrCreate(ROOT_FOLDER_ID(), key) };
  }
  return { kind: 'railway', key, studentId: rows[0].id, orgId };
}

// ── Student record ───────────────────────────────────────────────────────────

async function readMeta(ref) {
  if (ref.kind === 'drive') return (await readStudentMeta(ref.dir.id)).meta;
  const { rows } = await query('SELECT record_enc FROM students WHERE id = $1 AND org_id = $2', [ref.studentId, ref.orgId]);
  if (!rows[0]) throw Object.assign(new Error('Student not found'), { status: 404 });
  return decryptJson(rows[0].record_enc);
}

async function saveRailwayMeta(client, ref, meta) {
  const c = indexColumns(ref.key, meta);
  await client.query(
    `UPDATE students SET record_enc = $3, name = $4, email = $5, phone = $6,
       advisor = $7, consultancy = $8, loan_status = $9
     WHERE id = $1 AND org_id = $2`,
    [ref.studentId, ref.orgId, encryptJson(meta), c.name, c.email, c.phone, c.advisor, c.consultancy, c.loanStatus],
  );
}

async function writeMeta(ref, meta) {
  if (ref.kind === 'drive') return writeStudentMeta(ref.dir.id, meta);
  return saveRailwayMeta({ query }, ref, meta);
}

// Read-modify-write. On Railway the row is locked for the duration, so two
// concurrent edits (e.g. a loan-status change and a banker grant) can't
// overwrite each other. mutate() may return a new object or edit in place.
async function updateMeta(ref, mutate) {
  if (ref.kind === 'drive') {
    const meta = (await readStudentMeta(ref.dir.id)).meta;
    const next = (await mutate(meta)) || meta;
    await writeStudentMeta(ref.dir.id, next);
    return next;
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT record_enc FROM students WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [ref.studentId, ref.orgId],
    );
    if (!rows[0]) throw Object.assign(new Error('Student not found'), { status: 404 });
    const meta = decryptJson(rows[0].record_enc);
    const next = (await mutate(meta)) || meta;
    await saveRailwayMeta(client, ref, next);
    return next;
  });
}

// ── Listing (Railway side; Drive side stays in routes/students.js) ──────────

async function listRailwayStudents() {
  if (!isRailwayStorageReady()) return [];
  const orgIds = await scopeOrgIds();
  const [{ rows: students }, { rows: generated }, { rows: letters }] = await Promise.all([
    query(
      `SELECT s.id, s.org_id, s.folder_key, s.record_enc, s.updated_at, o.name AS org_name, o.slug AS org_slug
         FROM students s JOIN organizations o ON o.id = s.org_id
        WHERE ${ORG_FILTER(1, 's.org_id')} AND s.source = 'railway'
        ORDER BY s.updated_at DESC`,
      [orgIds],
    ),
    query(
      `SELECT DISTINCT ON (student_id, file_name) student_id, id, file_name, created_at
         FROM documents
        WHERE ${ORG_FILTER(1)} AND section = 'Others' AND file_name = ANY($2) AND deleted_at IS NULL
        ORDER BY student_id, file_name, created_at DESC`,
      [orgIds, GENERATED_FILES],
    ),
    // A sanction letter already in each file (matches services/sanctionLetter.js:
    // Loan_Documents/Sanction_Letter.* first, then Loan_Documents, then newest)
    query(
      `SELECT DISTINCT ON (student_id) student_id, id, section, file_name, created_at
         FROM documents
        WHERE ${ORG_FILTER(1)} AND deleted_at IS NULL AND file_name ILIKE '%sanction%'
        ORDER BY student_id, (section = 'Loan_Documents') DESC,
                 (lower(file_name) LIKE 'sanction_letter.%') DESC, created_at DESC`,
      [orgIds],
    ),
  ]);
  const found = new Map(letters.map((d) => [d.student_id, {
    fileId: toPublicId(d.id), name: d.file_name, section: d.section, uploadedAt: d.created_at.toISOString(), found: true,
  }]));

  const gen = new Map();
  for (const d of generated) {
    const entry = { fileId: toPublicId(d.id), webViewLink: null, updatedAt: d.created_at.toISOString() };
    const slot = gen.get(d.student_id) || {};
    if (d.file_name === 'Student_Summary.pdf') slot.summaryPdf = entry;
    else slot.eligibilityPdf = entry;
    gen.set(d.student_id, slot);
  }

  return students.map((s) => {
    const company = { id: s.org_id, name: s.org_name, slug: s.org_slug };
    const base = { name: s.folder_key, storage: 'railway', studentKey: s.folder_key, company };
    const { summaryPdf = null, eligibilityPdf = null } = gen.get(s.id) || {};
    let meta;
    try {
      meta = decryptJson(s.record_enc);
    } catch (err) {
      return { ...base, _parseError: 'Record could not be decrypted', updatedAt: s.updated_at.toISOString(), summaryPdf, eligibilityPdf };
    }
    const sanctionLetter = meta.sanctionLetter || found.get(s.id) || undefined;
    return { ...base, ...meta, sanctionLetter, storage: 'railway', studentKey: s.folder_key, company, updatedAt: s.updated_at.toISOString(), summaryPdf, eligibilityPdf };
  });
}

// Student self-service lookup by email/phone (the identifier half of the key).
// withOrg: also say which company the student belongs to ({ student, orgId }).
async function findRailwayStudentByIdentifier(identifier, { withOrg = false } = {}) {
  if (!isRailwayStorageReady()) return null;
  const sanitizedId = identifier.replace(/[^a-zA-Z0-9 _\-.]/g, '_');
  const { rows } = await query(
    `SELECT id, org_id, folder_key, record_enc FROM students
      WHERE ${ORG_FILTER(1)} AND source = 'railway'
        AND (lower(identifier) = lower($2) OR lower(identifier) = lower($3)
             OR lower(email) = lower($2) OR phone = $2)
      ORDER BY updated_at DESC LIMIT 1`,
    [await scopeOrgIds(), identifier, sanitizedId],
  );
  if (!rows[0]) return null;
  const meta = decryptJson(rows[0].record_enc);
  const sep = rows[0].folder_key.indexOf('__');
  const displayName = sep >= 0 ? rows[0].folder_key.slice(0, sep) : rows[0].folder_key;
  const student = { ...meta, name: meta.name || displayName, storage: 'railway', studentKey: rows[0].folder_key };
  return withOrg ? { student, orgId: rows[0].org_id } : student;
}

// ── Documents (Railway students only) ────────────────────────────────────────

// Stores an encrypted copy in the bucket, then records it. Earlier versions
// with any of `replaces` names in the same section are marked deleted (kept
// in the bucket, like Drive's trash) only once the new one is safely saved.
// File names come from the browser: no path separators or control
// characters, so a name can't escape its folder inside a zip download.
const cleanFileName = (name) => String(name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) || 'file';

async function storeDocument(ref, { section, fileName: rawName, mimeType, buffer, uploadedBy, replaces = [] }) {
  if (ref.kind !== 'railway') throw new Error('storeDocument is for Railway students only');
  const fileName = cleanFileName(rawName);
  const documentId = crypto.randomUUID();
  const key = documentKey({ orgId: ref.orgId, studentId: ref.studentId, documentId });
  const stored = await putEncrypted(key, buffer);
  const names = Array.from(new Set([fileName, ...replaces.map(cleanFileName)]));

  try {
    await withTransaction(async (client) => {
      // Serialises uploads for this student so two replacements of the
      // same file can't both pass the "no live copy" unique index.
      await client.query('SELECT 1 FROM students WHERE id = $1 FOR UPDATE', [ref.studentId]);
      await client.query(
        `UPDATE documents SET deleted_at = now()
          WHERE student_id = $1 AND section = $2 AND file_name = ANY($3) AND deleted_at IS NULL`,
        [ref.studentId, section, names],
      );
      await client.query(
        `INSERT INTO documents (id, org_id, student_id, section, file_name, mime_type, size_bytes,
                                storage, storage_key, encryption, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'bucket', $8, $9, $10, $11)`,
        [documentId, ref.orgId, ref.studentId, section, fileName, mimeType || 'application/octet-stream',
          stored.sizeBytes, key, stored.encryption, stored.sha256, uploadedBy || null],
      );
      await client.query('UPDATE students SET updated_at = now() WHERE id = $1', [ref.studentId]);
    });
  } catch (err) {
    await deleteObject(key).catch(() => {});
    throw err;
  }
  return { id: toPublicId(documentId), name: fileName };
}

async function listDocuments(ref) {
  const { rows } = await query(
    `SELECT id, section, file_name, mime_type, size_bytes, created_at FROM documents
      WHERE student_id = $1 AND org_id = $2 AND deleted_at IS NULL
      ORDER BY section, created_at`,
    [ref.studentId, ref.orgId],
  );
  return rows.map((r) => ({
    id: toPublicId(r.id), section: r.section, name: r.file_name,
    mimeType: r.mime_type, size: r.size_bytes == null ? null : String(r.size_bytes), createdAt: r.created_at,
  }));
}

async function findLatestDocument(ref, section, fileName) {
  const { rows } = await query(
    `SELECT id FROM documents
      WHERE student_id = $1 AND org_id = $2 AND section = $3 AND file_name = $4 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [ref.studentId, ref.orgId, section, fileName],
  );
  return rows[0] ? toPublicId(rows[0].id) : null;
}

// Looks up a document by its public id → { doc, ref } or null.
async function getDocument(publicId) {
  const id = parsePublicId(publicId);
  if (!id || !isRailwayStorageReady()) return null;
  const { rows } = await query(
    `SELECT d.id, d.org_id, d.file_name, d.mime_type, d.storage_key, d.sha256, s.id AS student_id, s.folder_key
       FROM documents d JOIN students s ON s.id = d.student_id
      WHERE d.id = $1 AND ${ORG_FILTER(2, 'd.org_id')} AND d.deleted_at IS NULL AND d.storage = 'bucket'`,
    [id, await scopeOrgIds()],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    doc: { id: toPublicId(r.id), name: r.file_name, mimeType: r.mime_type, storageKey: r.storage_key, sha256: r.sha256 },
    ref: { kind: 'railway', key: r.folder_key, studentId: r.student_id, orgId: r.org_id },
  };
}

async function readDocumentBytes(publicId) {
  const found = await getDocument(publicId);
  if (!found) return null;
  return { ...found.doc, buffer: await getDecrypted(found.doc.storageKey, found.doc.sha256) };
}

// Permanently removes a Railway student, every document row and every
// stored object (including replaced versions).
async function deleteRailwayStudent(ref) {
  const keys = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT storage_key FROM documents WHERE student_id = $1 AND storage = 'bucket'",
      [ref.studentId],
    );
    await client.query('DELETE FROM students WHERE id = $1 AND org_id = $2', [ref.studentId, ref.orgId]);
    return rows.map((r) => r.storage_key);
  });
  const results = await Promise.allSettled(keys.map((k) => deleteObject(k)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.warn(`[storage] student deleted but ${failed} bucket object(s) could not be removed`);
  return { documents: keys.length, failed };
}

module.exports = {
  GENERATED_FILES,
  ownerOrgId,
  studentKeyOf,
  isRailwayFileId,
  resolveStudent,
  resolveOrCreateStudent,
  readMeta,
  writeMeta,
  updateMeta,
  listRailwayStudents,
  findRailwayStudentByIdentifier,
  storeDocument,
  listDocuments,
  findLatestDocument,
  getDocument,
  readDocumentBytes,
  deleteRailwayStudent,
};
