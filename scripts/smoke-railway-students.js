// npm run test:students — end-to-end check of the new-student flow on
// Railway storage, through the real API routes, against the LOCAL dev
// database and the DEV bucket.
//
// Google Drive stays connected for read-only lookups (old students), but
// the two things that would write to it — the audit log and the Google
// Docs HTML→PDF conversion — are stubbed so a test run leaves no trace in
// the real Drive. Everything the test creates is deleted at the end.
require('dotenv').config();
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');

if (!/student-documents-dev/.test(process.env.BUCKET_NAME || '')) {
  console.error('Refusing to run: BUCKET_NAME is not the dev bucket.');
  process.exit(1);
}
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing to run: DATABASE_URL is not a local database.');
  process.exit(1);
}

// ── Stub the Drive writers before the app loads them ─────────────────────────
const audit = [];
const stub = (rel, exports) => {
  const file = require.resolve(path.join('..', 'src', 'services', rel));
  const real = require(file);
  require.cache[file].exports = { ...real, ...exports };
};
stub('auditLog', { logAudit: (entry) => audit.push(entry) });
const TINY_PDF = Buffer.from('%PDF-1.4\n% generated eligibility report stand-in\n%%EOF\n');
stub('pdf', { convertHtmlToPdf: async () => TINY_PDF });

const app = require('../src/index');
const { initRailwayStorage } = require('../src/db/startup');
const { query, closeDb } = require('../src/db');
const { getRaw } = require('../src/services/objectStore');
const { findFolderByName, ROOT_FOLDER_ID } = require('../src/services/drive');

const sign = (name, role) => jwt.sign({ name, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
const SUPER = sign('Smoke Superadmin', 'superadmin');
const BANKER = sign('Smoke Bank', 'banker');

const stamp = Date.now();
const NAME = 'Railway Smoke';
const ID = `smoke-${stamp}@example.com`;
const KEY = `Railway Smoke__smoke-${stamp}_example.com`; // sanitize(buildFolderKey(...))
const PDF_A = Buffer.from(`%PDF-1.4 passport scan A ${stamp}`);
const PDF_B = Buffer.from(`%PDF-1.4 passport scan B ${stamp} — replacement`);

let base;
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}: ${err.message}`); }
};

async function call(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(base + url, { method, headers, body });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

function uploadForm(buffer, fileName = 'Passport.pdf') {
  const fd = new FormData();
  fd.append('studentName', NAME);
  fd.append('studentIdentifier', ID);
  fd.append('subFolder', 'GOVT ID');
  fd.append('fileName', fileName);
  fd.append('skipOcr', '1');
  fd.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
  return fd;
}

(async () => {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  let fileId;
  let storageKeys = [];

  try {
    assert.ok(await initRailwayStorage(), 'Railway storage must be ready');

    await step('new student registers on Railway, not in Drive', async () => {
      const meta = { name: NAME, email: ID, advisor: 'Smoke Advisor', personalInfo: { panNumber: 'ABCPR9876K' } };
      const r = await call('POST', '/api/student-meta', {
        json: { studentName: NAME, studentIdentifier: ID, metaJson: JSON.stringify(meta) },
      });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      const { rows } = await query("SELECT source, email, advisor, record_enc FROM students WHERE folder_key = $1", [KEY]);
      assert.strictEqual(rows.length, 1, 'one row');
      assert.strictEqual(rows[0].source, 'railway');
      assert.strictEqual(rows[0].advisor, 'Smoke Advisor');
      assert.ok(!rows[0].record_enc.toString('latin1').includes('ABCPR9876K'), 'PAN must be encrypted');
      assert.strictEqual(await findFolderByName(ROOT_FOLDER_ID(), KEY), null, 'no Drive folder created');
    });

    await step('double registration resolves to the same student', async () => {
      const send = () => call('POST', '/api/student-meta', {
        json: { studentName: NAME, studentIdentifier: ID, metaJson: JSON.stringify({ name: NAME, email: ID, advisor: 'Smoke Advisor' }) },
      });
      await Promise.all([send(), send()]);
      const { rows } = await query('SELECT count(*)::int AS n FROM students WHERE folder_key = $1', [KEY]);
      assert.strictEqual(rows[0].n, 1);
    });

    await step('student upload goes to the encrypted bucket', async () => {
      const r = await call('POST', '/api/student-upload', { form: uploadForm(PDF_A) });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      assert.match(r.data.fileId, /^rw_/);
      assert.strictEqual(r.data.webViewLink, null);
      fileId = r.data.fileId;
    });

    await step('re-uploading the same document replaces it', async () => {
      const r = await call('POST', '/api/student-upload', { form: uploadForm(PDF_B) });
      assert.strictEqual(r.data.success, true);
      const { rows } = await query(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live, count(*)::int AS total
           FROM documents d JOIN students s ON s.id = d.student_id
          WHERE s.folder_key = $1 AND d.file_name = 'Passport.pdf'`, [KEY]);
      assert.deepStrictEqual(rows[0], { live: 1, total: 2 });
      fileId = r.data.fileId;
    });

    await step('summary + eligibility report saved to the bucket', async () => {
      const fd = new FormData();
      fd.append('studentName', NAME);
      fd.append('studentIdentifier', ID);
      fd.append('documents', '[]');
      fd.append('summaryPdf', new Blob([Buffer.from('%PDF-1.4 summary')], { type: 'application/pdf' }), 'summary.pdf');
      const r = await call('POST', '/api/student-summary', { form: fd });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      assert.match(r.data.fileId, /^rw_/);
      assert.match(r.data.eligibilityReport.fileId, /^rw_/);
    });

    await step('unregistered student cannot upload', async () => {
      const fd = uploadForm(PDF_A);
      fd.set('studentIdentifier', `nobody-${stamp}@example.com`);
      const r = await call('POST', '/api/student-upload', { form: fd });
      assert.strictEqual(r.status, 404);
    });

    await step('admin list includes the Railway student with its summary', async () => {
      const r = await call('GET', '/api/students', { token: SUPER });
      const s = r.data.students.find((x) => x.studentKey === KEY);
      assert.ok(s, 'student listed');
      assert.strictEqual(s.storage, 'railway');
      assert.match(s.summaryPdf.fileId, /^rw_/);
      assert.match(s.eligibilityPdf.fileId, /^rw_/);
    });

    await step('student can resume by email', async () => {
      const r = await call('GET', `/api/students/find?identifier=${encodeURIComponent(ID)}`);
      assert.strictEqual(r.data.success, true);
      assert.strictEqual(r.data.student.advisor, 'Smoke Advisor');
    });

    await step('staff file listing groups by section and hides internal files', async () => {
      const r = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files`, { token: SUPER });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      assert.deepStrictEqual(r.data.groups['GOVT ID'].map((f) => f.name), ['Passport.pdf']);
      const others = (r.data.groups.Others || []).map((f) => f.name);
      assert.ok(others.includes('Student_Summary.pdf'));
      assert.ok(!others.includes('Eligibility_Report.pdf'), 'eligibility report hidden');
    });

    await step('banker without access is refused everywhere', async () => {
      const files = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files`, { token: BANKER });
      const content = await call('GET', `/api/files/${fileId}/content?token=${BANKER}`);
      const zip = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files/zip?token=${BANKER}`);
      const loan = await call('PUT', `/api/students/${encodeURIComponent(KEY)}/loan-status`, { token: BANKER, json: { loanStatus: 'inprocess' } });
      assert.deepStrictEqual([files.status, content.status, zip.status, loan.status], [403, 403, 403, 403]);
      assert.strictEqual((await call('GET', '/api/students', { token: BANKER })).data.students.some((s) => s.studentKey === KEY), false);
    });

    await step('superadmin grants the banker access', async () => {
      const r = await call('PUT', '/api/students/banker-access', {
        token: SUPER, json: { studentName: NAME, studentIdentifier: ID, bankerName: 'Smoke Bank', grant: true },
      });
      assert.deepStrictEqual(r.data.sharedBankers, ['Smoke Bank']);
    });

    await step('banker with access gets the exact document back', async () => {
      const r = await call('GET', `/api/files/${fileId}/content?token=${BANKER}&mode=download`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.data.equals(PDF_B), 'bytes must match the latest upload');
      assert.match(r.headers.get('content-disposition'), /^attachment; filename="Passport.pdf"/);
      assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    });

    await step('banker downloads all documents as a zip', async () => {
      const r = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files/zip?token=${BANKER}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.slice(0, 2).toString(), 'PK');
      assert.ok(r.data.includes(Buffer.from('GOVT ID/Passport.pdf')), 'zip keeps sections as folders');
    });

    await step('banker updates loan status; searchable column follows', async () => {
      const r = await call('PUT', `/api/students/${encodeURIComponent(KEY)}/loan-status`, {
        token: BANKER, json: { loanStatus: 'sanctioned' },
      });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      const { rows } = await query('SELECT loan_status FROM students WHERE folder_key = $1', [KEY]);
      assert.strictEqual(rows[0].loan_status, 'sanctioned');
    });

    await step('stored objects are ciphertext only', async () => {
      const { rows } = await query(
        `SELECT d.storage_key FROM documents d JOIN students s ON s.id = d.student_id WHERE s.folder_key = $1`, [KEY]);
      storageKeys = rows.map((r) => r.storage_key);
      for (const k of storageKeys) {
        const raw = await getRaw(k);
        assert.ok(!raw.includes(Buffer.from('%PDF')), `object ${k} must not be plaintext`);
      }
    });

    await step('audit trail recorded for registration, uploads and access', async () => {
      const actions = new Set(audit.map((a) => a.action));
      for (const a of ['student.save', 'document.upload', 'summary.generate', 'banker_access.grant', 'loan_status.update']) {
        assert.ok(actions.has(a), `missing audit action ${a}`);
      }
    });

    await step('delete removes the student, rows and every stored object', async () => {
      const r = await call('DELETE', '/api/students', { token: SUPER, json: { studentKey: KEY } });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      const { rows } = await query('SELECT count(*)::int AS n FROM students WHERE folder_key = $1', [KEY]);
      assert.strictEqual(rows[0].n, 0);
      for (const k of storageKeys) await assert.rejects(() => getRaw(k), `object ${k} should be gone`);
    });
  } catch (err) {
    results.push(`FAIL  ${err.message}`);
  } finally {
    // Safety net if a step failed before the delete step ran.
    await call('DELETE', '/api/students', { token: SUPER, json: { studentKey: KEY } }).catch(() => {});
    server.close();
    await closeDb();
  }

  console.log(results.join('\n'));
  const failed = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
