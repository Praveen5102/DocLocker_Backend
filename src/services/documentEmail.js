// Emails a student's documents from the DocLocker mailbox, in the
// background: the request returns a job at once and the page checks on it.
//
// Sending uses Gmail SMTP with an app password for the sending account:
//   SMTP_USER   the mailbox, e.g. doclocker20@gmail.com
//   SMTP_PASS   its Gmail app password (Google Account > Security >
//               2-Step Verification > App passwords); never the real password
//   SMTP_HOST / SMTP_PORT   optional, default smtp.gmail.com / 465
//   MAIL_FROM_NAME          optional, default "DocLocker"
//   DOCUMENT_EMAIL_PRESETS  optional, comma-separated addresses offered as
//                           ticks to Flyurdream staff
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { visibleFiles, fileBytes } = require('./studentFiles');
const { readMeta } = require('./studentStore');
const { logAudit } = require('./auditLog');

const DEFAULT_PRESETS = ['Pratheek@flyurdream.com', 'Hyderabad@flyurdream.com'];
const presets = () => (process.env.DOCUMENT_EMAIL_PRESETS
  ? process.env.DOCUMENT_EMAIL_PRESETS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_PRESETS);

const isConfigured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);

let transport = null;
let testTransport = null;
function getTransport() {
  if (testTransport) return testTransport;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}
// Tests send through nodemailer's in-memory transport instead
function useTestTransport(t) { testTransport = t; }

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const MAX_RECIPIENTS = 5;
const MAX_FILES = 30;
// Gmail takes 25 MB per email after encoding; files go out in parts below this
const PART_BYTES = 17 * 1024 * 1024;

// ── Jobs ─────────────────────────────────────────────────────────────────────
// Kept in memory for a day; the outcome is also in the audit log.
const jobs = new Map();
const JOB_TTL = 24 * 60 * 60 * 1000;
function prune() {
  const cutoff = Date.now() - JOB_TTL;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}
const publicJob = (j) => ({
  id: j.id, status: j.status, studentName: j.studentName, recipients: j.recipients, files: j.files.length,
  parts: j.parts, error: j.error || null, createdAt: new Date(j.createdAt).toISOString(),
  finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null,
});
function getJob(id, admin) {
  const j = jobs.get(id);
  if (!j || j.orgId !== admin.orgId) return null;
  if (j.requestedBy !== admin.name && !['superadmin', 'admin'].includes(admin.role)) return null;
  return publicJob(j);
}

// ── Checks (run before a job is queued) ──────────────────────────────────────
function cleanRecipients(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const e = String(raw || '').trim();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) throw Object.assign(new Error(`"${e}" isn't a valid email address`), { status: 400 });
    if (!seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); out.push(e); }
  }
  if (!out.length) throw Object.assign(new Error('Choose at least one email address'), { status: 400 });
  if (out.length > MAX_RECIPIENTS) throw Object.assign(new Error(`Send to at most ${MAX_RECIPIENTS} addresses at once`), { status: 400 });
  return out;
}

// files: [{ id, label }] — every id must be one of this student's documents
async function pickFiles(ref, files) {
  const wanted = (Array.isArray(files) ? files : []).slice(0, MAX_FILES + 1);
  if (!wanted.length) throw Object.assign(new Error('There are no documents to send'), { status: 400 });
  if (wanted.length > MAX_FILES) throw Object.assign(new Error(`Send at most ${MAX_FILES} documents at once`), { status: 400 });
  const own = new Map((await visibleFiles(ref)).map((f) => [f.id, f]));
  return wanted.map((w) => {
    const f = own.get(String(w?.id || ''));
    if (!f) throw Object.assign(new Error('One of the documents is not in this student\'s file'), { status: 400 });
    return { ...f, label: String(w.label || f.name).replace(/[\r\n]+/g, ' ').slice(0, 120) };
  });
}

// ── The email ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safeName = (s) => String(s || 'document').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
const extOf = (name) => (/\.([a-z0-9]{2,5})$/i.exec(name || '') || [])[1] || '';

function buildMessage({ studentName, applicationId, labels, sender, company, note, part, parts }) {
  const who = applicationId ? `${studentName} (${applicationId})` : studentName;
  const partNote = parts > 1 ? ` (part ${part} of ${parts})` : '';
  const subject = `${who}: passport and academic documents${partNote}`;
  const intro = `Please find attached the passport and academic documents for ${studentName}${applicationId ? `, application ${applicationId}` : ''}.`;
  const by = `Sent by ${sender}${company ? ` (${company})` : ''} through DocLocker.`;
  const privacy = 'These documents contain personal information. Please keep them within your team.';
  const text = [
    'Hello,', '', intro, parts > 1 ? `This is part ${part} of ${parts}; the rest follow in separate emails.` : null, '',
    `Attached (${labels.length}):`, ...labels.map((l) => `  - ${l}`), '',
    note ? `Note: ${note}` : null, note ? '' : null, by, '', privacy,
  ].filter((l) => l !== null).join('\n');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#0b1e4a">
  <p>Hello,</p>
  <p>${esc(intro)}</p>
  ${parts > 1 ? `<p>This is part ${part} of ${parts}; the rest follow in separate emails.</p>` : ''}
  <p style="margin:16px 0 6px"><strong>Attached (${labels.length})</strong></p>
  <ul style="margin:0 0 16px;padding-left:20px">${labels.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  ${note ? `<p style="padding:10px 12px;border-left:3px solid #f2a623;background:#fff8ea"><strong>Note:</strong> ${esc(note)}</p>` : ''}
  <p style="color:#4a5673">${esc(by)}</p>
  <p style="font-size:12px;color:#6b7491">${esc(privacy)}</p>
</div>`;
  return { subject, text, html };
}

// Files into emails of at most PART_BYTES each (one oversize file goes alone)
function intoParts(files) {
  const parts = [];
  let cur = [];
  let size = 0;
  for (const f of files) {
    if (cur.length && size + f.buffer.length > PART_BYTES) { parts.push(cur); cur = []; size = 0; }
    cur.push(f);
    size += f.buffer.length;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

async function run(job, ref) {
  job.status = 'sending';
  try {
    const meta = await readMeta(ref).catch(() => ({}));
    const studentName = job.studentName;
    const loaded = [];
    for (const f of job.files) {
      const buffer = await fileBytes(ref, f);
      if (!buffer) throw new Error(`${f.label} could not be read`);
      const ext = extOf(f.name);
      loaded.push({ ...f, buffer, filename: `${safeName(studentName)} - ${safeName(f.label)}${ext ? `.${ext}` : ''}` });
    }
    const parts = intoParts(loaded);
    job.parts = parts.length;
    const from = { name: process.env.MAIL_FROM_NAME || 'DocLocker', address: process.env.SMTP_USER };
    for (let i = 0; i < parts.length; i++) {
      const msg = buildMessage({
        studentName, applicationId: meta.applicationId || '', labels: parts[i].map((f) => f.label),
        sender: job.requestedBy, company: job.company, note: job.note, part: i + 1, parts: parts.length,
      });
      await getTransport().sendMail({
        from, to: job.recipients, subject: msg.subject, text: msg.text, html: msg.html,
        attachments: parts[i].map((f) => ({ filename: f.filename, content: f.buffer, contentType: f.mimeType || undefined })),
      });
    }
    job.status = 'sent';
    job.finishedAt = Date.now();
    logAudit({ orgId: job.orgId, actor: job.requestedBy, role: job.role, action: 'document.email', target: job.studentKey,
      details: { to: job.recipients.join(', '), files: job.files.length, ...(parts.length > 1 ? { parts: parts.length } : {}) } });
  } catch (err) {
    job.status = 'failed';
    job.finishedAt = Date.now();
    // Say what went wrong in the person's terms; the detail goes to the log
    job.error = /auth|535|534|invalid login|username and password/i.test(err.message)
      ? 'The DocLocker mailbox refused the sign-in. Check SMTP_USER and the app password on the server.'
      : /could not be read/.test(err.message) ? err.message : 'The email could not be sent. Try again in a few minutes.';
    console.error('document email failed:', err.message);
    logAudit({ orgId: job.orgId, actor: job.requestedBy, role: job.role, action: 'document.email_failed', target: job.studentKey,
      details: { to: job.recipients.join(', '), files: job.files.length, reason: job.error } });
  }
}

// Checks everything, queues the job and returns it straight away
async function queueEmail({ admin, ref, recipients, files, note }) {
  if (!isConfigured() && !testTransport) {
    throw Object.assign(new Error('Email isn\'t set up on the server yet. Add SMTP_USER and SMTP_PASS (a Gmail app password) to the backend settings.'), { status: 503 });
  }
  const to = cleanRecipients(recipients);
  const picked = await pickFiles(ref, files);
  prune();
  const job = {
    id: crypto.randomUUID(), status: 'queued', orgId: admin.orgId, requestedBy: admin.name, role: admin.role,
    company: admin.company?.name || '', studentKey: ref.key, studentName: ref.key.split('__')[0] || 'Student',
    recipients: to, files: picked, note: String(note || '').trim().slice(0, 500), parts: 0, createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  setImmediate(() => { run(job, ref); });
  return publicJob(job);
}

module.exports = { queueEmail, getJob, presets, isConfigured, useTestTransport, buildMessage };
