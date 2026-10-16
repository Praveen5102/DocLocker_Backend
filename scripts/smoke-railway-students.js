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
// convertToPdf normally runs Google's OCR through Drive; the test supplies
// the "OCR text" itself (fakeOcr) so the other-board fallback can be tested.
let fakeOcr = '';
stub('pdf', { convertHtmlToPdf: async () => TINY_PDF, convertToPdf: async () => ({ pdfBuffer: null, extractedText: fakeOcr }) });

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

// Test documents for the upload gate, built as real PDFs our model can read.
async function textPdf(lines) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 450]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 400 - i * 38, size: 22, font }));
  return Buffer.from(await doc.save());
}

// Default slot (Resume) isn't checked by the upload gate.
function uploadForm(buffer, fileName = 'Resume.pdf', subFolder = 'GOVT ID') {
  const fd = new FormData();
  fd.append('studentName', NAME);
  fd.append('studentIdentifier', ID);
  fd.append('subFolder', subFolder);
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
          WHERE s.folder_key = $1 AND d.file_name = 'Resume.pdf'`, [KEY]);
      assert.deepStrictEqual(rows[0], { live: 1, total: 2 });
      fileId = r.data.fileId;
    });

    const PAN_PDF = await textPdf(['INCOME TAX DEPARTMENT', 'GOVT. OF INDIA', 'Permanent Account Number Card', 'ABCPK1234F',
      'Name', 'RAILWAY SMOKE', 'Date of Birth', '12/06/2004']);
    const HOLIDAY_PDF = await textPdf(['Holiday photos', 'Goa beach 2023']);
    const slotFiles = async (name) => (await query(
      `SELECT count(*)::int AS n FROM documents d JOIN students s ON s.id = d.student_id
        WHERE s.folder_key = $1 AND d.file_name = $2 AND d.deleted_at IS NULL`, [KEY, name])).rows[0].n;

    await step('gate: a wrong document in the PAN slot is rejected and never saved', async () => {
      const r = await call('POST', '/api/student-upload', { form: uploadForm(HOLIDAY_PDF, 'PAN_Card.pdf') });
      assert.strictEqual(r.status, 422, JSON.stringify(r.data));
      assert.strictEqual(r.data.rejected, true);
      assert.match(r.data.error, /doesn’t look like a PAN card/);
      assert.strictEqual(await slotFiles('PAN_Card.pdf'), 0);
    });

    await step('gate: a PAN card in the passport slot is rejected', async () => {
      const r = await call('POST', '/api/student-upload', { form: uploadForm(PAN_PDF, 'Passport.pdf') });
      assert.strictEqual(r.status, 422, JSON.stringify(r.data));
      assert.strictEqual(await slotFiles('Passport.pdf'), 0);
    });

    await step('gate: the right document is accepted, saved and read in one step', async () => {
      const r = await call('POST', '/api/student-upload', { form: uploadForm(PAN_PDF, 'PAN_Card.pdf') });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      assert.strictEqual(r.data.reader.gate.status, 'accepted');
      assert.strictEqual(r.data.reader.extraction.flat.pan_number, 'ABCPK1234F');
      assert.strictEqual(r.data.reader.extraction.gate.status, 'accepted');
      assert.strictEqual(r.data.reader.parsedData.type, 'pan');
      assert.strictEqual(await slotFiles('PAN_Card.pdf'), 1);
    });

    await step('gate: 10th slot rejects a random file, accepts another board’s memo from its text', async () => {
      fakeOcr = 'Holiday photos Goa beach 2023';
      const bad = await call('POST', '/api/student-upload', { form: uploadForm(HOLIDAY_PDF, '10th_Marksheet.pdf', 'Academics') });
      assert.strictEqual(bad.status, 422, JSON.stringify(bad.data));
      fakeOcr = 'CENTRAL BOARD OF SECONDARY EDUCATION Secondary School Examination 2019 Marks Statement Roll No Subject Total Result PASS';
      const ok = await call('POST', '/api/student-upload', { form: uploadForm(HOLIDAY_PDF, '10th_Marksheet.pdf', 'Academics') });
      fakeOcr = '';
      assert.strictEqual(ok.data.success, true, JSON.stringify(ok.data));
      assert.strictEqual(ok.data.reader.gate.status, 'accepted');
      assert.match(ok.data.reader.gate.reason, /Board not read by our model/);
    });

    await step('gate: other slots are not checked', async () => {
      const r = await call('POST', '/api/student-upload', { form: uploadForm(HOLIDAY_PDF, 'Visa_History.pdf') });
      assert.strictEqual(r.data.success, true, JSON.stringify(r.data));
      assert.strictEqual(r.data.reader, undefined);
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
      assert.ok(r.data.groups['GOVT ID'].map((f) => f.name).includes('Resume.pdf'));
      const others = (r.data.groups.Others || []).map((f) => f.name);
      assert.ok(others.includes('Student_Summary.pdf'));
      assert.ok(!others.includes('Eligibility_Report.pdf'), 'eligibility report hidden');
    });

    await step('banker without access is refused everywhere', async () => {
      const files = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files`, { token: BANKER });
      const content = await call('GET', `/api/files/${fileId}/content`, { token: BANKER });
      const zip = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files/zip`, { token: BANKER });
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

    await step('banker with access views the exact document in the app', async () => {
      const r = await call('GET', `/api/files/${fileId}/content?mode=view`, { token: BANKER });
      assert.strictEqual(r.status, 200);
      assert.ok(r.data.equals(PDF_B), 'bytes must match the latest upload');
      assert.match(r.headers.get('content-disposition'), /^inline; filename="Resume.pdf"/);
      assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    });

    await step('a login token in the URL is refused', async () => {
      const r = await call('GET', `/api/files/${fileId}/content?token=${BANKER}`);
      assert.strictEqual(r.status, 401);
      const z = await call('GET', `/api/students/${encodeURIComponent(KEY)}/files/zip?token=${BANKER}`);
      assert.strictEqual(z.status, 401);
    });

    await step('one-time download link works once, for that file only', async () => {
      const link = await call('POST', `/api/files/${fileId}/download-link`, { token: BANKER });
      assert.strictEqual(link.data.success, true);
      assert.ok(!link.data.url.includes(BANKER), 'link must not contain the login token');
      const first = await call('GET', link.data.url);
      assert.strictEqual(first.status, 200);
      assert.ok(first.data.equals(PDF_B));
      assert.match(first.headers.get('content-disposition'), /^attachment;/);
      const again = await call('GET', link.data.url);
      assert.strictEqual(again.status, 401, 'second use must be refused');

      const other = await call('POST', `/api/files/${fileId}/download-link`, { token: BANKER });
      const ticket = new URL(base + other.data.url).searchParams.get('ticket');
      const swapped = await call('GET', `/api/files/rw_00000000-0000-0000-0000-000000000000/content?ticket=${encodeURIComponent(ticket)}`);
      assert.strictEqual(swapped.status, 401, 'ticket for one file must not open another');
      const asLogin = await call('GET', '/api/students', { token: ticket });
      assert.strictEqual(asLogin.status, 401, 'ticket must not work as a login token');
    });

    await step('banker downloads all documents as a zip via a one-time link', async () => {
      const link = await call('POST', `/api/students/${encodeURIComponent(KEY)}/files/zip-link`, { token: BANKER });
      const r = await call('GET', link.data.url);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.slice(0, 2).toString(), 'PK');
      assert.ok(r.data.includes(Buffer.from('GOVT ID/Resume.pdf')), 'zip keeps sections as folders');
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
      const views = audit.filter((a) => a.action === 'document.view');
      assert.ok(views.every((v) => v.actor === 'Smoke Bank' && v.target === KEY && v.details.file === 'Resume.pdf'), 'view entries name who, which student, which file');
      for (const a of ['student.save', 'document.upload', 'document.rejected', 'summary.generate', 'banker_access.grant', 'loan_status.update',
        'document.view', 'document.download', 'document.download_all']) {
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
