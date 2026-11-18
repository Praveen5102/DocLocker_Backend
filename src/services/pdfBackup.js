// Readable PDF backups of every student, in the owner's Google Drive.
//
// One PDF per student: a cover with every detail of the record, then every
// document merged in (PDFs page by page, photos as pages; anything that
// can't be merged is attached to the PDF instead). The exact record is also
// attached as student_record.json, so it can be restored with the Recovery
// screen (routes/recovery.js) — not just read.
//
// This is the second, human-readable copy beside the encrypted nightly
// backup (services/backup.js): useful if the backend, the database or the
// encryption key is ever lost.
//
// When:   a few minutes after any change to a student (debounced, so a burst
//         of autosaves makes one PDF), plus a weekly run over everyone that
//         skips students whose PDF is already up to date.
// Where:  My Drive > DocLocker_Student_PDFs > <company> > <student> > dated PDFs.
//         A top-level folder of its own, so it never inherits sharing from
//         another folder. Only the Drive owner account can open it: every run
//         removes any other access found on it, and nothing is ever shared
//         by link.
// Kept:   the newest 3 versions, the newest of each of the last 4 weeks, and
//         always the richest older version (most documents, then most
//         details) — so if a record is ever wiped, the new "empty" PDFs can
//         never push out the last good one.
//
// Opt-in with PDF_BACKUP_ENABLED=true (production only — a local backend
// shares the production Drive).

const crypto = require('crypto');
const { Readable } = require('stream');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { query, getPool } = require('../db');
const { getDrive, getOrCreate, listFolders, ROOT_FOLDER_ID } = require('./drive');
const { readMeta, resolveStudent } = require('./studentStore');
const { visibleFiles, fileBytes } = require('./studentFiles');
const { runWithScope, ownerOrgId } = require('./tenantScope');
const { events } = require('./studentEvents');

const WEEKLY_LOCK_ID = 727303;
const DEBOUNCE_MS = 2 * 60 * 1000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_NEWEST = 3;
const KEEP_WEEKS = 4;
const GONE_GRACE_DAYS = 30;

const isEnabled = () => process.env.PDF_BACKUP_ENABLED === 'true';

// ── Drive folders ────────────────────────────────────────────────────────────

let rootPromise = null;
function pdfRoot() {
  if (!rootPromise) {
    rootPromise = (async () => {
      const root = process.env.PDF_BACKUP_DRIVE_FOLDER_ID
        ? { id: process.env.PDF_BACKUP_DRIVE_FOLDER_ID }
        : await getOrCreate('root', process.env.PDF_BACKUP_FOLDER_NAME || 'DocLocker_Student_PDFs');
      await enforceOwnerOnly(root.id);
      return root;
    })().catch((err) => { rootPromise = null; throw err; });
  }
  return rootPromise;
}

const companyNames = new Map();
async function companyName(orgId) {
  if (!companyNames.has(orgId)) {
    const { rows } = await query('SELECT name FROM organizations WHERE id = $1', [orgId]);
    companyNames.set(orgId, rows[0]?.name || orgId);
  }
  return companyNames.get(orgId);
}

async function studentFolder(orgId, key) {
  const root = await pdfRoot();
  const company = await getOrCreate(root.id, await companyName(orgId));
  return getOrCreate(company.id, key);
}

// Only the owner account may open the backups. Any other access found on
// the folder (a person, a group, a link) is removed and reported.
async function enforceOwnerOnly(folderId) {
  const drive = getDrive();
  const [{ data: about }, { data: perms }] = await Promise.all([
    drive.about.get({ fields: 'user(permissionId)' }),
    drive.permissions.list({ fileId: folderId, fields: 'permissions(id,type,role,emailAddress,domain)' }),
  ]);
  const removed = [];
  for (const p of perms.permissions || []) {
    if (p.id === about.user.permissionId || p.role === 'owner') continue;
    const who = `${p.type}:${p.emailAddress || p.domain || p.id}`;
    try {
      await drive.permissions.delete({ fileId: folderId, permissionId: p.id });
      removed.push(who);
    } catch (err) {
      removed.push(`${who} (could not remove: ${err.message})`);
    }
  }
  if (removed.length) console.warn(`[pdf-backup] removed access to the backup folder: ${removed.join(', ')}`);
  return removed;
}

// ── PDF building ─────────────────────────────────────────────────────────────

// The standard PDF fonts only cover Latin-1; swap the usual exceptions.
const SWAP = {
  '₹': 'Rs.', '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-',
  '…': '...', ' ': ' ', '•': '*', '✓': 'yes', '·': '-',
};
const safe = (v) => String(v ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
  .replace(/[^\n\x20-\x7e¡-ÿ]/g, (c) => SWAP[c] ?? '?');

const PAGE = [595.28, 841.89]; // A4
const MARGIN = 48;
const INK = rgb(0.06, 0.1, 0.24);
const MUTED = rgb(0.36, 0.43, 0.53);
const RULE = rgb(0.85, 0.88, 0.93);

class Writer {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(PAGE);
    this.y = PAGE[1] - MARGIN;
  }

  ensure(h) {
    if (this.y - h < MARGIN) this.newPage();
  }

  lines(text, font, size, width) {
    const out = [];
    for (const para of safe(text).split('\n')) {
      let line = '';
      for (let word of para.split(/\s+/).filter(Boolean)) {
        // A word wider than the column (an email, a long id) is broken up.
        while (font.widthOfTextAtSize(word, size) > width) {
          let cut = word.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut -= 1;
          if (line) { out.push(line); line = ''; }
          out.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  text(text, { size = 10, bold = false, color = INK, x = MARGIN, width = PAGE[0] - 2 * MARGIN, gap = 3 } = {}) {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    for (const line of this.lines(text, font, size, width)) {
      this.ensure(size + gap);
      this.page.drawText(line, { x, y: this.y - size, size, font, color });
      this.y -= size + gap;
    }
  }

  heading(text) {
    this.ensure(44);
    this.y -= 12;
    this.text(text, { size: 13, bold: true });
    this.page.drawLine({ start: { x: MARGIN, y: this.y - 2 }, end: { x: PAGE[0] - MARGIN, y: this.y - 2 }, thickness: 0.7, color: RULE });
    this.y -= 8;
  }

  pair(label, value) {
    const labelW = 170;
    const valueW = PAGE[0] - 2 * MARGIN - labelW - 10;
    const size = 9.5;
    const l = this.lines(label, this.fonts.bold, size, labelW);
    const v = this.lines(value, this.fonts.regular, size, valueW);
    const rows = Math.max(l.length, v.length);
    for (let i = 0; i < rows; i += 1) {
      this.ensure(size + 3);
      if (l[i]) this.page.drawText(l[i], { x: MARGIN, y: this.y - size, size, font: this.fonts.bold, color: MUTED });
      if (v[i]) this.page.drawText(v[i], { x: MARGIN + labelW + 10, y: this.y - size, size, font: this.fonts.regular, color: INK });
      this.y -= size + 3;
    }
    this.y -= 2;
  }
}

// "consultantNameLoc" → "Consultant name loc"
const humanize = (k) => String(k)
  .replace(/^co_info_\d+$/, (m) => `Co-applicant ${Number(m.split('_').pop()) + 1}`)
  .replace(/_/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase())
  .replace(/\s+(\S)/g, (m, c) => ` ${c.toLowerCase()}`);

const isEmpty = (v) => v === undefined || v === null || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);

// A nested value as readable text.
function asText(v, depth = 0) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map((x) => asText(x, depth + 1)).filter(Boolean).join(depth ? ', ' : '\n');
  return Object.entries(v).filter(([, x]) => !isEmpty(x)).map(([k, x]) => `${humanize(k)}: ${asText(x, depth + 1)}`).join(depth ? '; ' : '\n');
}

const REASONS = {
  credit_score: 'Low credit score', co_applicant_income: 'Co-applicant income', collateral: 'Collateral not accepted',
  university_course: 'University or course', academics: 'Academic scores', documents: 'Documents',
  existing_loans: 'Existing loans or defaults', loan_amount: 'Amount too high', other: 'Other reason',
};

function priorBankLines(p) {
  if (p.priorBankApplied !== 'Yes') return [];
  const list = Array.isArray(p.priorBanks)
    ? p.priorBanks
    : [{ bank: p.priorBankName === 'Others' ? p.priorBankNameCustom : p.priorBankName }];
  return list.filter((e) => e && e.bank).map((e) => [e.bank, [REASONS[e.reason], e.note].filter(Boolean).join(' - ') || '-']);
}

// Machine-shaped parts of the record: summarised in the documents index or
// kept only in the attached JSON.
const RECORD_INTERNALS = new Set([
  'uploads', 'uploadedDocuments', 'extractions', 'identityCheck', 'reviewFields', 'autoFilledFields', 'personalInfo',
  'sharedBankers', 'name', 'email', 'phone', 'applicationId', 'advisor', 'loanStatus', 'loanRemark',
  'loanStatusUpdatedBy', 'loanStatusUpdatedAt', 'applicationSubmittedAt', 'createdAt', 'coApplicants',
]);

const istStamp = (d = new Date()) => {
  const t = new Date(d.getTime() + 330 * 60 * 1000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)} IST`;
};
const sizeText = (n) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function renderCover(doc, fonts, { ref, company, meta, items, offset }) {
  const w = new Writer(doc, fonts);
  const p = meta.personalInfo || {};
  const name = meta.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || ref.key.split('__')[0];

  w.text('DocLocker student backup', { size: 9, bold: true, color: MUTED });
  w.y -= 2;
  w.text(name, { size: 20, bold: true });
  w.text(`Backed up ${istStamp()}  -  ${company}`, { size: 9.5, color: MUTED });
  w.y -= 6;
  w.text('Confidential: contains personal documents. Do not share or forward.', { size: 9, bold: true, color: rgb(0.7, 0.1, 0.1) });

  w.heading('Application');
  const head = [
    ['Application ID', meta.applicationId], ['Email', meta.email || p.email], ['Mobile', meta.phone || p.phone],
    ['Company', company], ['Advisor', meta.advisor], ['Loan status', meta.loanStatus],
    ['Loan remark', meta.loanRemark],
    ['Status updated', [meta.loanStatusUpdatedBy, meta.loanStatusUpdatedAt].filter(Boolean).join(', ')],
    ['Lenders shared with', (meta.sharedBankers || []).join(', ')],
    ['Submitted', meta.applicationSubmittedAt], ['Created', meta.createdAt],
    ['Co-applicants', meta.coApplicants], ['Stored on', ref.kind === 'railway' ? 'Railway (encrypted)' : 'Google Drive'],
    ['Record key', ref.key],
  ];
  for (const [k, v] of head) if (!isEmpty(v)) w.pair(k, asText(v));

  const details = Object.entries(p).filter(([k, v]) => !k.startsWith('co_info_') && !k.startsWith('priorBank') && !isEmpty(v));
  if (details.length) {
    w.heading('Student details');
    for (const [k, v] of details) w.pair(humanize(k), asText(v));
  }

  const banks = priorBankLines(p);
  if (p.priorBankApplied) {
    w.heading('Lenders tried before');
    if (!banks.length) w.pair('Applied to a bank before', p.priorBankApplied);
    for (const [bank, why] of banks) w.pair(bank, why);
  }

  for (const [k, v] of Object.entries(p).filter(([key, v]) => key.startsWith('co_info_') && !isEmpty(v))) {
    w.heading(humanize(k));
    for (const [ck, cv] of Object.entries(v).filter(([, x]) => !isEmpty(x))) w.pair(humanize(ck), asText(cv));
  }

  const other = Object.entries(meta).filter(([k, v]) => !RECORD_INTERNALS.has(k) && !isEmpty(v));
  if (other.length) {
    w.heading('Other record details');
    for (const [k, v] of other) w.pair(humanize(k), asText(v));
  }

  w.heading(`Documents (${items.length})`);
  if (!items.length) w.text('No documents uploaded.', { size: 9.5, color: MUTED });
  let page = offset + 1;
  for (const it of items) {
    let where;
    if (it.pages) { where = it.pages === 1 ? `page ${page}` : `pages ${page}-${page + it.pages - 1}`; page += it.pages; }
    else where = it.error ? `NOT INCLUDED: ${it.error}` : 'attached to this PDF (open the attachments panel)';
    w.pair(`${it.file.group ? `${it.file.group} / ` : ''}${it.file.name}`, `${where}${it.file.size ? `  (${sizeText(Number(it.file.size))})` : ''}`);
  }

  w.y -= 10;
  w.text('The exact record is attached as student_record.json. To restore it, paste it into Recovery on the student in DocLocker.', { size: 8.5, color: MUTED });
  return doc.getPageCount();
}

async function loadItems(ref, files) {
  const items = [];
  for (const file of files) {
    const it = { file, pages: 0 };
    try {
      const raw = await fileBytes(ref, file);
      if (!raw) throw new Error('file not found');
      // A copy of its own: Node can hand back a slice of a shared buffer,
      // which pdf-lib would read from the wrong offset.
      it.bytes = new Uint8Array(raw);
      const type = String(file.mimeType || '').toLowerCase();
      const name = String(file.name || '').toLowerCase();
      if (type === 'application/pdf' || name.endsWith('.pdf')) {
        const src = await PDFDocument.load(it.bytes, { ignoreEncryption: true });
        if (!src.isEncrypted) {
          // A damaged PDF can load and still fail to copy: try it now, so
          // the cover's page numbers only count PDFs that will merge.
          await (await PDFDocument.create()).copyPages(src, src.getPageIndices());
          it.src = src;
          it.pages = src.getPageCount();
        }
      } else if (/image\/jpe?g/.test(type) || /\.jpe?g$/.test(name)) {
        it.image = 'jpg'; it.pages = 1;
      } else if (type === 'image/png' || name.endsWith('.png')) {
        it.image = 'png'; it.pages = 1;
      }
    } catch (err) {
      if (!it.bytes) it.error = `could not read (${err.message})`;
      // A PDF we couldn't parse is still attached as it is.
    }
    items.push(it);
  }
  return items;
}

async function buildPdf({ ref, company, meta, files, record }) {
  const items = await loadItems(ref, files);

  const make = async () => {
    const doc = await PDFDocument.create();
    const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
    return { doc, fonts };
  };
  // The cover lists each document's page numbers, which depend on how long
  // the cover itself is: measure it first, then draw it for real.
  let offset = 0;
  for (let i = 0; i < 3; i += 1) {
    const trial = await make();
    const pages = renderCover(trial.doc, trial.fonts, { ref, company, meta, items, offset });
    if (pages === offset) break;
    offset = pages;
  }
  const { doc, fonts } = await make();
  renderCover(doc, fonts, { ref, company, meta, items, offset });

  for (const it of items) {
    try {
      if (it.src) {
        const pages = await doc.copyPages(it.src, it.src.getPageIndices());
        pages.forEach((pg) => doc.addPage(pg));
      } else if (it.image) {
        const img = it.image === 'jpg' ? await doc.embedJpg(it.bytes) : await doc.embedPng(it.bytes);
        const page = doc.addPage(PAGE);
        const scale = Math.min((PAGE[0] - 2 * MARGIN) / img.width, (PAGE[1] - 2 * MARGIN) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (PAGE[0] - w) / 2, y: (PAGE[1] - h) / 2, width: w, height: h });
      }
    } catch (err) {
      // Pages already counted on the cover: keep the numbering honest with a
      // placeholder, and attach the original.
      for (let i = 0; i < it.pages; i += 1) {
        const page = doc.addPage(PAGE);
        page.drawText(safe(`${it.file.name}: could not be merged (${err.message}). The original is attached.`).slice(0, 110), { x: MARGIN, y: PAGE[1] - MARGIN - 12, size: 10, font: fonts.regular, color: INK });
      }
      it.attach = true;
      it.mergeError = err.message;
    }
    if ((!it.pages || it.attach) && it.bytes) {
      await doc.attach(it.bytes, safe(it.file.name) || 'document', {
        mimeType: it.file.mimeType || 'application/octet-stream',
        description: safe(`${it.file.group || ''} ${it.file.name}`).trim(),
      });
    }
  }

  await doc.attach(Buffer.from(JSON.stringify(record, null, 2), 'utf8'), 'student_record.json', {
    mimeType: 'application/json', description: 'The exact student record',
  });
  doc.setTitle(safe(`DocLocker backup - ${meta.name || ref.key}`));
  doc.setAuthor('DocLocker');
  doc.setSubject('Confidential student backup');
  return {
    bytes: Buffer.from(await doc.save()),
    documents: items.length,
    missing: items.filter((i) => i.error).length,
    attachedOnly: items.filter((i) => i.attach || (!i.pages && !i.error)).map((i) => `${i.file.name}${i.mergeError ? ` (${i.mergeError})` : ''}`),
  };
}

// ── Backing up one student ───────────────────────────────────────────────────

// How much the record holds, so pruning can tell a good copy from a wiped one.
function countDetails(v) {
  if (isEmpty(v)) return 0;
  if (typeof v !== 'object') return 1;
  return Object.values(v).reduce((n, x) => n + countDetails(x), 0);
}

function fingerprint(meta, files) {
  const list = files.map((f) => [f.id, f.name, f.size, f.updatedAt ? String(f.updatedAt) : '']).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify(meta)).update(JSON.stringify(list)).digest('hex');
}

async function fileAlive(fileId) {
  try {
    const { data } = await getDrive().files.get({ fileId, fields: 'id, trashed' });
    return !data.trashed;
  } catch {
    return false;
  }
}

async function uploadPdf(folderId, name, bytes, props) {
  const { data } = await getDrive().files.create({
    requestBody: {
      name, parents: [folderId], mimeType: 'application/pdf',
      // Viewers (there should be none) can't download, print or copy it.
      copyRequiresWriterPermission: true, writersCanShare: false,
      appProperties: props,
    },
    media: { mimeType: 'application/pdf', body: Readable.from(bytes) },
    fields: 'id, name',
  });
  return data;
}

// Keep the newest few, one per recent week, and the richest older copy.
async function prune(folderId) {
  const drive = getDrive();
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType = 'application/pdf'`,
    fields: 'files(id, name, createdTime, appProperties)', orderBy: 'createdTime desc', pageSize: 200, spaces: 'drive',
  });
  const files = data.files || [];
  if (files.length <= KEEP_NEWEST) return 0;
  const score = (f) => [Number(f.appProperties?.documents || 0), Number(f.appProperties?.details || 0)];
  const keep = new Set(files.slice(0, KEEP_NEWEST).map((f) => f.id));
  const weeks = new Set();
  for (const f of files) {
    const age = Date.now() - new Date(f.createdTime).getTime();
    const week = Math.floor(age / (7 * DAY_MS));
    if (week < KEEP_WEEKS && !weeks.has(week)) { weeks.add(week); keep.add(f.id); }
  }
  const richest = files.slice().sort((a, b) => {
    const [ad, af] = score(a); const [bd, bf] = score(b);
    return bd - ad || bf - af;
  })[0];
  keep.add(richest.id);
  let removed = 0;
  for (const f of files) {
    if (keep.has(f.id)) continue;
    await drive.files.delete({ fileId: f.id }).then(() => { removed += 1; }, (err) => console.error('[pdf-backup] prune failed:', err.message));
  }
  return removed;
}

async function recordError(orgId, key, message) {
  await query(
    `INSERT INTO pdf_backups (org_id, student_key, last_error, last_error_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (org_id, student_key) DO UPDATE SET last_error = $3, last_error_at = now()`,
    [orgId, key, String(message).slice(0, 500)],
  ).catch(() => {});
}

// → { status: 'saved' | 'unchanged' | 'gone' | 'empty', ... }
async function backupStudent({ key, orgId }, { force = false } = {}) {
  return runWithScope({ orgIds: [orgId], homeOrgId: orgId }, async () => {
    try {
      const ref = await resolveStudent(key);
      if (!ref || ref.orgId !== orgId) return { status: 'gone' };
      // A read failure throws here: never back up a record we couldn't read.
      const meta = await readMeta(ref);
      const files = await visibleFiles(ref);
      if (isEmpty(meta) && !files.length) return { status: 'empty' };

      const fp = fingerprint(meta, files);
      const { rows: [prev] } = await query('SELECT fingerprint, file_id FROM pdf_backups WHERE org_id = $1 AND student_key = $2', [orgId, key]);
      if (!force && prev?.fingerprint === fp && prev.file_id && (await fileAlive(prev.file_id))) return { status: 'unchanged' };

      const company = await companyName(orgId);
      const { bytes, documents, missing } = await buildPdf({ ref, company, meta, files, record: meta });
      const folder = await studentFolder(orgId, key);
      const name = safe(`${meta.name || key.split('__')[0]} - ${meta.applicationId || 'no ID'} - ${istStamp().replace(':', '')}.pdf`).replace(/[\\/]/g, '-');
      const file = await uploadPdf(folder.id, name, bytes, {
        documents: String(documents), details: String(countDetails(meta)), fp: fp.slice(0, 16),
      });
      await query(
        `INSERT INTO pdf_backups (org_id, student_key, fingerprint, folder_id, file_id, file_name, documents, bytes, backed_up_at, last_error, last_error_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), NULL, NULL)
         ON CONFLICT (org_id, student_key) DO UPDATE SET fingerprint = $3, folder_id = $4, file_id = $5, file_name = $6,
           documents = $7, bytes = $8, backed_up_at = now(), last_error = NULL, last_error_at = NULL`,
        [orgId, key, fp, folder.id, file.id, name, documents, bytes.length],
      );
      const pruned = await prune(folder.id).catch((err) => { console.error('[pdf-backup] prune failed:', err.message); return 0; });
      return { status: 'saved', documents, missing, bytes: bytes.length, pruned };
    } catch (err) {
      await recordError(orgId, key, err.message);
      throw err;
    }
  });
}

// ── After every change ───────────────────────────────────────────────────────

const pending = new Map();
const queued = new Set();
let chain = Promise.resolve();

// One build at a time, so memory stays bounded.
function enqueue(target) {
  const id = `${target.orgId}|${target.key}`;
  if (queued.has(id)) return;
  queued.add(id);
  chain = chain.then(async () => {
    queued.delete(id); // a change during this build queues another
    try {
      const r = await backupStudent(target);
      if (r.status === 'saved') console.log(`[pdf-backup] ${target.key}: saved (${r.documents} documents${r.missing ? `, ${r.missing} unreadable` : ''})`);
    } catch (err) {
      console.error(`[pdf-backup] ${target.key}: failed - ${err.message}`);
    }
  });
}

// Waits for the changes to settle (2 minutes quiet, at most 10 minutes).
function onStudentChanged(ref) {
  const target = { key: ref.key, orgId: ref.orgId };
  const id = `${target.orgId}|${target.key}`;
  const entry = pending.get(id) || { firstAt: Date.now() };
  clearTimeout(entry.timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, entry.firstAt + MAX_WAIT_MS - Date.now()));
  entry.timer = setTimeout(() => { pending.delete(id); enqueue(target); }, wait);
  entry.timer.unref?.();
  pending.set(id, entry);
}

// ── Weekly run over everyone ─────────────────────────────────────────────────

async function allStudents() {
  const { rows } = await query("SELECT org_id, folder_key FROM students WHERE source = 'railway' ORDER BY created_at");
  const out = rows.map((r) => ({ orgId: r.org_id, key: r.folder_key }));
  const onRailway = new Set(out.map((s) => s.key));
  const owner = await ownerOrgId();
  for (const f of await listFolders(ROOT_FOLDER_ID())) {
    if (!onRailway.has(f.name)) out.push({ orgId: owner, key: f.name });
  }
  return out;
}

async function runWeekly({ kind = 'weekly', force = false, log = console.log } = {}) {
  const lockClient = await getPool().connect();
  const { rows: [{ locked }] } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [WEEKLY_LOCK_ID]);
  if (!locked) {
    lockClient.release();
    log('[pdf-backup] a run is already in progress - skipped');
    return { skipped: true };
  }
  const { rows: [run] } = await query('INSERT INTO pdf_backup_runs (kind) VALUES ($1) RETURNING id', [kind]);
  const details = { students: 0, saved: 0, unchanged: 0, empty: 0, failed: 0, failures: [], accessRemoved: [], removedGone: 0 };
  try {
    const root = await pdfRoot();
    details.accessRemoved = await enforceOwnerOnly(root.id);
    const students = await allStudents();
    details.students = students.length;
    for (const s of students) {
      try {
        const r = await backupStudent(s, { force });
        details[r.status === 'saved' ? 'saved' : r.status === 'empty' ? 'empty' : 'unchanged'] += 1;
      } catch (err) {
        details.failed += 1;
        details.failures.push(`${s.key}: ${err.message}`.slice(0, 200));
      }
    }
    // Students deleted from DocLocker: their backups go 30 days later.
    const live = new Set(students.map((s) => `${s.orgId}|${s.key}`));
    const { rows: tracked } = await query('SELECT org_id, student_key, folder_id, backed_up_at FROM pdf_backups');
    for (const t of tracked) {
      if (live.has(`${t.org_id}|${t.student_key}`)) continue;
      if (t.backed_up_at && Date.now() - t.backed_up_at.getTime() < GONE_GRACE_DAYS * DAY_MS) continue;
      if (t.folder_id) await getDrive().files.delete({ fileId: t.folder_id }).catch(() => {});
      await query('DELETE FROM pdf_backups WHERE org_id = $1 AND student_key = $2', [t.org_id, t.student_key]);
      details.removedGone += 1;
    }
    const status = details.failed ? 'failed' : 'ok';
    await query('UPDATE pdf_backup_runs SET finished_at = now(), status = $2, details = $3 WHERE id = $1', [run.id, status, details]);
    log(`[pdf-backup] ${kind} run ${status}: ${details.saved} saved, ${details.unchanged} up to date, ${details.failed} failed of ${details.students}`);
    return { status, ...details };
  } catch (err) {
    await query("UPDATE pdf_backup_runs SET finished_at = now(), status = 'failed', details = $2 WHERE id = $1", [run.id, { ...details, error: err.message }]);
    throw err;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [WEEKLY_LOCK_ID]).catch(() => {});
    lockClient.release();
  }
}

// Sundays 03:00 IST (Saturday 21:30 UTC), plus a catch-up run after boot if
// the last good weekly run is more than 8 days old.
function startPdfBackups() {
  if (!isEnabled()) {
    console.log('[pdf-backup] off (PDF_BACKUP_ENABLED is not "true")');
    return;
  }
  events.on('changed', onStudentChanged);
  const safeRun = () => runWeekly().catch((err) => console.error('[pdf-backup] weekly run crashed:', err.message));
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 30));
  next.setUTCDate(next.getUTCDate() + ((6 - next.getUTCDay() + 7) % 7));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  setTimeout(() => { safeRun(); setInterval(safeRun, 7 * DAY_MS).unref(); }, next - now).unref();
  setTimeout(async () => {
    try {
      const { rows } = await query("SELECT max(finished_at) AS last FROM pdf_backup_runs WHERE status = 'ok'");
      const last = rows[0].last ? rows[0].last.getTime() : 0;
      if (Date.now() - last > 8 * DAY_MS) safeRun();
    } catch (err) {
      console.error('[pdf-backup] catch-up check failed:', err.message);
    }
  }, 10 * 60 * 1000).unref();
  console.log(`[pdf-backup] on - after every change, and weekly (next ${next.toISOString()})`);
}

module.exports = { startPdfBackups, backupStudent, runWeekly, buildPdf, enforceOwnerOnly, prune };
