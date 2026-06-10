const { getPercentageInfo, ACADEMIC_TYPES } = require('./documentParser');

const DOC_LABELS = {
  aadhaar:  'Aadhaar Card',
  pan:      'PAN Card',
  passport: 'Passport',
  '10th':   '10th / SSC',
  '12th':   '12th / HSC',
  pc:       'Provisional Certificate',
  degree:   'Degree Certificate',
  diploma:  'Diploma Certificate',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(text, bg, color = '#fff') {
  return `<span style="background:${bg};color:${color};font-family:Arial,sans-serif;font-size:10px;font-weight:bold;padding:3px 9px;border-radius:3px;letter-spacing:.5px;">${text}</span>`;
}

function fieldRow(label, value) {
  const SKIP = new Set(['Score Type', 'Display Score']);
  if (SKIP.has(label)) return '';
  const display = value
    ? `<span style="font-family:Arial,sans-serif;font-size:12px;color:#111827;font-weight:600;">${esc(value)}</span>`
    : `<span style="font-family:Arial,sans-serif;font-size:12px;color:#d1d5db;font-style:italic;">Not detected</span>`;
  return `
    <tr>
      <td style="padding:7px 14px;font-family:Arial,sans-serif;font-size:11px;color:#6b7280;width:42%;border-bottom:1px solid #f3f4f6;vertical-align:top;">${esc(label)}</td>
      <td style="padding:7px 14px;border-bottom:1px solid #f3f4f6;vertical-align:top;">${display}</td>
    </tr>`;
}

// ── Name helpers ──────────────────────────────────────────────────────────────

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function compareNames(ref, candidate) {
  const r = normalizeName(ref);
  const c = normalizeName(candidate);
  if (!r || !c) return 'unknown';
  if (r === c) return 'match';
  const rWords = r.split(' ').filter(w => w.length > 1);
  const cWords = c.split(' ').filter(w => w.length > 1);
  const common  = rWords.filter(w => cWords.includes(w));
  const minLen  = Math.min(rWords.length, cWords.length);
  if (common.length >= minLen) return 'match';
  if (common.length >= Math.max(1, Math.ceil(minLen * 0.5))) return 'partial';
  return 'mismatch';
}

function getDocName(doc) {
  if (doc.fields['Name']) return doc.fields['Name'];
  if (doc.type === 'passport' && doc.fields['Surname']) {
    return (doc.fields['Surname'] + ' ' + (doc.fields['Given Name'] || '')).trim();
  }
  return null;
}

// ── Name Verification block ───────────────────────────────────────────────────

function buildNameVerification(parsedDocs) {
  const govtDocs     = parsedDocs.filter(d => ['aadhaar', 'pan', 'passport'].includes(d.type));
  const academicDocs = parsedDocs.filter(d => ACADEMIC_TYPES.has(d.type));
  const ordered      = [...govtDocs, ...academicDocs];

  // Reference = first govt ID that yields a name (Aadhaar → PAN → Passport)
  let refName = null;
  for (const t of ['aadhaar', 'pan', 'passport']) {
    const doc = govtDocs.find(d => d.type === t);
    if (doc) { const n = getDocName(doc); if (n) { refName = n; break; } }
  }

  const entries = [];
  for (const doc of ordered) {
    const name = getDocName(doc);
    if (!name) continue;
    const label = DOC_LABELS[doc.type] || doc.subFolder;
    const isRef = entries.length === 0; // first entry is always the reference

    let statusBg, statusText;
    if (isRef) {
      statusBg = '#1e3a8a'; statusText = '★ Reference';
    } else {
      const cmp = compareNames(refName, name);
      if      (cmp === 'match')    { statusBg = '#16a34a'; statusText = '✓ MATCH'; }
      else if (cmp === 'partial')  { statusBg = '#d97706'; statusText = '⚠ PARTIAL'; }
      else                         { statusBg = '#dc2626'; statusText = '✗ MISMATCH'; }
    }
    entries.push({ label, name, statusBg, statusText });
  }

  if (entries.length === 0) return '';

  const hasProblem = entries.some(e => e.statusText === '✗ MISMATCH' || e.statusText === '⚠ PARTIAL');

  const alertBanner = hasProblem
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:10px 16px;margin-bottom:14px;">
         <span style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#b91c1c;">
           ⚠ Name discrepancy detected — please verify with applicant before proceeding.
         </span>
       </div>`
    : `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:10px 16px;margin-bottom:14px;">
         <span style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#15803d;">
           ✓ All names match across documents.
         </span>
       </div>`;

  const rows = entries.map((e, i) => `
    <tr style="background:${i % 2 === 0 ? '#fff' : '#f9fafb'};">
      <td style="padding:9px 12px;font-family:Arial,sans-serif;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${esc(e.label)}</td>
      <td style="padding:9px 12px;font-family:Arial,sans-serif;font-size:12px;color:#111827;font-weight:600;border-bottom:1px solid #e5e7eb;">${esc(e.name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;">${badge(e.statusText, e.statusBg)}</td>
    </tr>`).join('');

  return `
    <p style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#1e3a8a;margin:0 0 10px;">Name Verification</p>
    ${alertBanner}
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:30px;">
      <tr style="background:#1e3a8a;">
        <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;width:30%;">Document</td>
        <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;width:45%;">Name</td>
        <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;width:25%;">Status</td>
      </tr>
      ${rows}
    </table>`;
}

// ── Govt ID card ──────────────────────────────────────────────────────────────

function govtCard(doc) {
  const label = DOC_LABELS[doc.type] || 'Document';
  const rows  = Object.entries(doc.fields).length
    ? Object.entries(doc.fields).map(([k, v]) => fieldRow(k, v)).join('')
    : `<tr><td colspan="2" style="padding:10px 14px;font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;font-style:italic;">No fields extracted</td></tr>`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;margin-bottom:18px;overflow:hidden;">
      <tr style="background:#1e3a8a;">
        <td colspan="2" style="padding:10px 14px;">
          <span style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#fff;">${esc(label)}</span>
          <span style="font-family:Arial,sans-serif;font-size:10px;color:#93c5fd;margin-left:8px;">${esc(doc.sourceFile)}</span>
        </td>
      </tr>
      ${rows}
    </table>`;
}

// ── Academic table row (score-type aware) ─────────────────────────────────────

function academicRow(doc, isAlt) {
  const label        = DOC_LABELS[doc.type] || doc.subFolder;
  const pct          = doc.fields['Percentage'];
  const info         = getPercentageInfo(pct);
  const rowBg        = info ? info.bg    : (isAlt ? '#f9fafb' : '#ffffff');
  const color        = info ? info.color : '#374151';
  const scoreType    = doc.fields['Score Type']    || (pct ? 'Percentage' : null);
  const displayScore = doc.fields['Display Score'] || doc.fields['CGPA'] || doc.fields['Marks'] || doc.fields['Grade'] || pct;

  let scoreCell = `<span style="color:#9ca3af;font-size:11px;font-family:Arial,sans-serif;">—</span>`;
  if (displayScore) {
    const typePill = (scoreType && scoreType !== 'Percentage')
      ? `<span style="font-family:Arial,sans-serif;font-size:9px;background:#e0e7ff;color:#3730a3;border-radius:2px;padding:1px 5px;margin-right:4px;">${esc(scoreType)}</span>`
      : '';
    // Show "≈ XX.XX%" note only when the score was converted from another type
    const approxNote = (scoreType && scoreType !== 'Percentage' && pct)
      ? `<span style="font-family:Arial,sans-serif;font-size:10px;color:${color};opacity:0.75;display:block;margin-top:2px;">&#8776; ${esc(pct)}</span>`
      : '';
    scoreCell = `${typePill}<span style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:${color};">${esc(displayScore)}</span>${approxNote}`;
  }

  return `
    <tr style="background:${rowBg};">
      <td style="padding:9px 12px;font-family:Arial,sans-serif;font-size:12px;color:${color};font-weight:${info ? 'bold' : 'normal'};border-bottom:1px solid #e5e7eb;">${esc(label)}</td>
      <td style="padding:9px 12px;font-family:Arial,sans-serif;font-size:12px;color:${color};border-bottom:1px solid #e5e7eb;">${esc(doc.fields['Year of Passing'] || '—')}</td>
      <td style="padding:9px 12px;font-family:Arial,sans-serif;font-size:12px;color:${color};border-bottom:1px solid #e5e7eb;">${esc(doc.fields['Board / University'] || doc.fields['University'] || '—')}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;">${scoreCell}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;">${info ? badge(info.eligibility, info.badge) : '<span style="color:#9ca3af;font-size:11px;">—</span>'}</td>
    </tr>`;
}

// ── Additional / "other" document card ───────────────────────────────────────

function otherDocCard(doc) {
  const label = doc.subFolder || 'Document';
  const rows  = Object.entries(doc.fields).length
    ? Object.entries(doc.fields).map(([k, v]) => fieldRow(k, v)).join('')
    : `<tr><td colspan="2" style="padding:10px 14px;font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;font-style:italic;">No fields extracted</td></tr>`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;margin-bottom:18px;overflow:hidden;">
      <tr style="background:#374151;">
        <td colspan="2" style="padding:10px 14px;">
          <span style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#fff;">${esc(label)}</span>
          <span style="font-family:Arial,sans-serif;font-size:10px;color:#9ca3af;margin-left:8px;">${esc(doc.sourceFile)}</span>
        </td>
      </tr>
      ${rows}
    </table>`;
}

// ── Overall verdict ────────────────────────────────────────────────────────────

function computeOverall(academicDocs) {
  let worst = null;
  for (const doc of academicDocs) {
    const info = getPercentageInfo(doc.fields['Percentage']);
    if (!info) continue;
    if (!worst || info.val < worst.val) worst = info;
  }
  if (!worst) return {
    badge: '#64748b', eligibility: 'UNDETERMINED', bg: '#f1f5f9',
    border: '#cbd5e1', color: '#475569',
    desc: 'No academic records found. Manual assessment required.',
  };

  const descs = {
    HIGH:        'Strong academic profile. Meets criteria for most education loan providers without conditions.',
    ELIGIBLE:    'Good academic profile. Eligible for education loans from SBI, HDFC Credila, Axis Bank.',
    CONDITIONAL: 'Average profile. May qualify with a co-applicant or additional collateral.',
    LOW:         'Below standard benchmarks. Loan approval will likely require a strong guarantor.',
  };
  return { ...worst, desc: descs[worst.eligibility] || '' };
}

// ── Main builder ──────────────────────────────────────────────────────────────

function buildEligibilityHtml(studentName, parsedDocs) {
  const govtDocs     = parsedDocs.filter(d => ['aadhaar', 'pan', 'passport'].includes(d.type));
  const academicDocs = parsedDocs.filter(d => ACADEMIC_TYPES.has(d.type));
  const otherDocs    = parsedDocs.filter(d => d.type === 'other');
  const overall      = computeOverall(academicDocs);
  const generatedOn  = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  // ── Cover ─────────────────────────────────────────────────────────────────
  const cover = `
    <table width="100%" cellpadding="0" cellspacing="0" style="min-height:841px;background:#0f172a;">
      <tr><td style="padding:70px 60px 30px;">
        <p style="font-family:Arial,sans-serif;font-size:10px;color:#475569;letter-spacing:3px;margin:0 0 50px;">FLYURDREAM · CONFIDENTIAL</p>
        <h1 style="font-family:Arial,sans-serif;font-size:36px;font-weight:bold;color:#fff;margin:0;line-height:1.15;">LOAN ELIGIBILITY</h1>
        <h1 style="font-family:Arial,sans-serif;font-size:36px;font-weight:bold;color:#3b82f6;margin:0 0 20px;line-height:1.15;">REPORT</h1>
        <div style="width:56px;height:4px;background:#3b82f6;margin-bottom:44px;"></div>
        <p style="font-family:Arial,sans-serif;font-size:13px;color:#94a3b8;margin:0 0 6px;">Prepared for</p>
        <h2 style="font-family:Arial,sans-serif;font-size:28px;font-weight:bold;color:#fff;margin:0 0 10px;">${esc(studentName)}</h2>
        <p style="font-family:Arial,sans-serif;font-size:12px;color:#64748b;margin:0 0 50px;">Generated on ${generatedOn}</p>

        <table cellpadding="0" cellspacing="0" style="border:1px solid ${overall.border};border-radius:8px;overflow:hidden;min-width:300px;">
          <tr><td style="background:${overall.badge};padding:10px 18px;">
            <span style="font-family:Arial,sans-serif;font-size:10px;font-weight:bold;color:#fff;letter-spacing:2px;">OVERALL LOAN ELIGIBILITY</span>
          </td></tr>
          <tr><td style="background:#1e293b;padding:14px 18px 4px;">
            <span style="font-family:Arial,sans-serif;font-size:24px;font-weight:bold;color:${overall.badge};">${overall.eligibility}</span>
          </td></tr>
          <tr><td style="background:#1e293b;padding:4px 18px 16px;">
            <span style="font-family:Arial,sans-serif;font-size:11px;color:#94a3b8;">${esc(overall.desc)}</span>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 60px 36px;vertical-align:bottom;">
        <p style="font-family:Arial,sans-serif;font-size:10px;color:#334155;border-top:1px solid #1e293b;padding-top:14px;margin:0;">
          Auto-generated from OCR-extracted document data. Manual verification recommended before final decision.
        </p>
      </td></tr>
    </table>`;

  // ── Section 1: Identity & Name Verification + Govt IDs ────────────────────
  const nameBlock  = buildNameVerification(parsedDocs);
  const govtBlock  = govtDocs.length
    ? govtDocs.map(govtCard).join('')
    : `<p style="font-family:Arial,sans-serif;font-size:13px;color:#9ca3af;font-style:italic;">No government ID documents uploaded.</p>`;

  const govtPage = `
    <div style="page-break-before:always;padding:44px 52px;">
      <p style="font-family:Arial,sans-serif;font-size:10px;color:#6b7280;letter-spacing:2px;margin:0 0 4px;">SECTION 1</p>
      <h2 style="font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#0f172a;margin:0 0 6px;">Identity &amp; Name Verification</h2>
      <div style="width:40px;height:3px;background:#3b82f6;margin-bottom:26px;"></div>
      ${nameBlock}
      <p style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#1e3a8a;margin:0 0 12px;">Government Identification Documents</p>
      ${govtBlock}
    </div>`;

  // ── Section 2: Academic Performance ───────────────────────────────────────
  const academicRows = academicDocs.length
    ? academicDocs.map((d, i) => academicRow(d, i % 2 === 1)).join('')
    : `<tr><td colspan="5" style="padding:14px 12px;font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;font-style:italic;">No academic documents uploaded.</td></tr>`;

  const benchmarks = `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-top:22px;">
      <tr><td style="padding:14px 18px;">
        <p style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#1e3a8a;margin:0 0 10px;">Indian Bank Loan Eligibility Benchmarks</p>
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:3px 12px 3px 0;">${badge('HIGH', '#16a34a')}</td>
            <td style="font-family:Arial,sans-serif;font-size:11px;color:#374151;padding:3px 0;">75% and above — Eligible for most banks, no additional conditions</td>
          </tr>
          <tr>
            <td style="padding:3px 12px 3px 0;">${badge('ELIGIBLE', '#2563eb')}</td>
            <td style="font-family:Arial,sans-serif;font-size:11px;color:#374151;padding:3px 0;">60–74% — SBI, HDFC Credila, Axis Bank eligible</td>
          </tr>
          <tr>
            <td style="padding:3px 12px 3px 0;">${badge('CONDITIONAL', '#d97706')}</td>
            <td style="font-family:Arial,sans-serif;font-size:11px;color:#374151;padding:3px 0;">50–59% — May require co-applicant or collateral</td>
          </tr>
          <tr>
            <td style="padding:3px 12px 3px 0;">${badge('LOW', '#dc2626')}</td>
            <td style="font-family:Arial,sans-serif;font-size:11px;color:#374151;padding:3px 0;">Below 50% — Strong guarantor or collateral required</td>
          </tr>
        </table>
        <p style="font-family:Arial,sans-serif;font-size:10px;color:#94a3b8;margin:10px 0 0;">
          Scores reported as CGPA or Marks are automatically converted to an equivalent percentage for eligibility assessment.
        </p>
      </td></tr>
    </table>`;

  const academicPage = `
    <div style="page-break-before:always;padding:44px 52px;">
      <p style="font-family:Arial,sans-serif;font-size:10px;color:#6b7280;letter-spacing:2px;margin:0 0 4px;">SECTION 2</p>
      <h2 style="font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#0f172a;margin:0 0 6px;">Academic Performance</h2>
      <div style="width:40px;height:3px;background:#3b82f6;margin-bottom:26px;"></div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <tr style="background:#1e3a8a;">
          <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;">Qualification</td>
          <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;">Year</td>
          <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;">Board / University</td>
          <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;">Score</td>
          <td style="padding:10px 12px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#fff;">Status</td>
        </tr>
        ${academicRows}
      </table>
      ${benchmarks}
    </div>`;

  // ── Section 3: Additional Documents (only when present) ───────────────────
  let additionalPage = '';
  if (otherDocs.length > 0) {
    additionalPage = `
      <div style="page-break-before:always;padding:44px 52px;">
        <p style="font-family:Arial,sans-serif;font-size:10px;color:#6b7280;letter-spacing:2px;margin:0 0 4px;">SECTION 3</p>
        <h2 style="font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#0f172a;margin:0 0 6px;">Additional Documents</h2>
        <div style="width:40px;height:3px;background:#3b82f6;margin-bottom:26px;"></div>
        ${otherDocs.map(otherDocCard).join('')}
      </div>`;
  }

  // ── Final Summary page (section number adjusts if additional docs present) ──
  const summaryNum = otherDocs.length > 0 ? '4' : '3';
  const summaryPage = `
    <div style="page-break-before:always;padding:44px 52px;">
      <p style="font-family:Arial,sans-serif;font-size:10px;color:#6b7280;letter-spacing:2px;margin:0 0 4px;">SECTION ${summaryNum}</p>
      <h2 style="font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#0f172a;margin:0 0 6px;">Summary &amp; Verdict</h2>
      <div style="width:40px;height:3px;background:#3b82f6;margin-bottom:26px;"></div>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
        <tr>
          <td width="33%" style="padding-right:10px;vertical-align:top;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
              <tr><td style="padding:18px;text-align:center;">
                <div style="font-family:Arial,sans-serif;font-size:30px;font-weight:bold;color:#1e3a8a;">${parsedDocs.length}</div>
                <div style="font-family:Arial,sans-serif;font-size:11px;color:#3b82f6;margin-top:4px;">Documents Uploaded</div>
              </td></tr>
            </table>
          </td>
          <td width="33%" style="padding:0 5px;vertical-align:top;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
              <tr><td style="padding:18px;text-align:center;">
                <div style="font-family:Arial,sans-serif;font-size:30px;font-weight:bold;color:#14532d;">${govtDocs.length}</div>
                <div style="font-family:Arial,sans-serif;font-size:11px;color:#16a34a;margin-top:4px;">Govt IDs Verified</div>
              </td></tr>
            </table>
          </td>
          <td width="33%" style="padding-left:10px;vertical-align:top;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;">
              <tr><td style="padding:18px;text-align:center;">
                <div style="font-family:Arial,sans-serif;font-size:30px;font-weight:bold;color:#78350f;">${academicDocs.length}</div>
                <div style="font-family:Arial,sans-serif;font-size:11px;color:#d97706;margin-top:4px;">Academic Records</div>
              </td></tr>
            </table>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:${overall.bg};border:2px solid ${overall.border};border-radius:10px;">
        <tr><td style="padding:26px 30px;">
          <p style="font-family:Arial,sans-serif;font-size:10px;font-weight:bold;color:${overall.color};letter-spacing:2px;margin:0 0 6px;">FINAL VERDICT</p>
          <h2 style="font-family:Arial,sans-serif;font-size:28px;font-weight:bold;color:${overall.badge};margin:0 0 10px;">${overall.eligibility}</h2>
          <p style="font-family:Arial,sans-serif;font-size:13px;color:${overall.color};margin:0 0 16px;">${esc(overall.desc)}</p>
          <p style="font-family:Arial,sans-serif;font-size:10px;color:#9ca3af;margin:0;">
            This report is auto-generated from OCR data. Actual eligibility is subject to bank policies, income proof, and manual verification by the advisor.
          </p>
        </td></tr>
      </table>
    </div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;">
    ${cover}${govtPage}${academicPage}${additionalPage}${summaryPage}
  </body></html>`;
}

module.exports = { buildEligibilityHtml };
