// npm run export:lenders -- [out.xlsx]
// Read-only export of every lender (banker) contact in DocLocker to one Excel
// sheet, one row per contact. Columns DocLocker doesn't hold (branch, phone,
// designation, codes, products) are left blank for the team to fill in.
// Never reads password hashes or student data. INTERNAL ONLY.
//
// Against production (Railway's public database URL):
//   railway run --service Postgres node scripts/export-lenders.js lenders.xlsx
require('dotenv').config();
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { query, closeDb, isDbEnabled } = require('../src/db');

const SOURCE = process.env.LENDERS_JSON ? 'DocLocker production database (exported from the Railway backend)' : /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')
  ? 'local copy of the DocLocker database - may be behind production; last sign-in is not tracked locally'
  : 'DocLocker production database';
const OUT = path.resolve(process.argv[2] || `DocLocker_Lenders_${new Date().toISOString().slice(0, 10)}.xlsx`);

// The lenders going live first, in this order; each gets a row even with no contact.
const PRIORITY = [
  { name: 'Credila', match: /credila/i },
  { name: 'Avanse', match: /avanse/i },
  { name: 'Auxilo', match: /auxilo/i },
  { name: 'Poonawalla Fincorp', match: /poonawalla/i },
  { name: 'InCred', match: /incred/i },
];

const COLUMNS = [
  ['Lender name', 22], ['Branch name and city', 24], ['Branch address', 32], ['Contact person name', 22],
  ['Designation or role', 20], ['Email address', 30], ['Phone (mobile / landline)', 22], ['Lender code or reference ID', 20],
  ['Products covered (secured, unsecured, countries, courses)', 34], ['Notes (who handles new files / disbursements)', 40],
];

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // control characters are not allowed in XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function sheetXml(rows, { widths, header = true, freeze = true, filter = true }) {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.cells.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr" s="${r.style ?? 2}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join('')}</row>`).join('');
  const last = `${colName(widths.length - 1)}${rows.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${freeze && header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData>${filter && header ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF0B1E4A"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF0B1E4A"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B1E4A"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF4DE"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFDFE4F0"/></left><right style="thin"><color rgb="FFDFE4F0"/></right><top style="thin"><color rgb="FFDFE4F0"/></top><bottom style="thin"><color rgb="FFDFE4F0"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="6"><xf/>
<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
<xf borderId="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf fontId="2" applyFont="1"/>
<xf fontId="3" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs></styleSheet>`;

async function main() {
  // LENDERS_JSON=<file>: build the sheet from rows exported earlier (e.g. from
  // inside the Railway container) instead of querying a database.
  const fromJson = process.env.LENDERS_JSON;
  if (!fromJson && !isDbEnabled()) throw new Error('DATABASE_URL is not set');
  // Explicit columns: no password hashes, no tokens.
  const { rows } = fromJson ? { rows: JSON.parse(fs.readFileSync(fromJson, 'utf8').replace(/^[\s\S]*?(\[)/, '$1')) } : await query(
    `SELECT a.name, a.email, a.bank, a.status, a.last_login_at, a.created_at, o.name AS company
       FROM accounts a JOIN organizations o ON o.id = a.org_id
      WHERE a.role = 'banker'
      ORDER BY a.bank NULLS LAST, a.name`);

  const lenderOf = (bank) => PRIORITY.find((p) => p.match.test(bank || ''))?.name || (bank || '').trim() || 'Bank not set';
  // Many lender logins were created with the email as the name; don't
  // present an email (or a guess) as a person's name.
  const realName = (r) => (r.name && !r.name.includes('@') && r.name.trim().toLowerCase() !== (r.email || '').toLowerCase() ? r.name.trim() : '');
  const contacts = rows.map((r) => ({
    lender: lenderOf(r.bank), cells: [
      lenderOf(r.bank), '', '', realName(r), '', r.email || r.name || '', '', '', '',
      [realName(r) ? '' : 'Name not stored in DocLocker (login uses email only).',
        r.bank && lenderOf(r.bank) !== r.bank.trim() ? `Bank as entered in DocLocker: ${r.bank}.` : ''].filter(Boolean).join(' '),
    ],
  }));
  const rank = (l) => { const i = PRIORITY.findIndex((p) => p.name === l); return i < 0 ? PRIORITY.length : i; };
  contacts.sort((a, b) => rank(a.lender) - rank(b.lender) || a.lender.localeCompare(b.lender));
  // Priority lenders with no contact still get a (highlighted) row.
  for (const p of PRIORITY) {
    if (!contacts.some((c) => c.lender === p.name)) {
      contacts.push({ lender: p.name, style: 3, cells: [p.name, '', '', '', '', '', '', '', '', 'No contact in DocLocker yet - add the branch and contact details'] });
    }
  }
  contacts.sort((a, b) => rank(a.lender) - rank(b.lender) || a.lender.localeCompare(b.lender));

  const lenders = [{ style: 1, cells: COLUMNS.map((c) => c[0]) }, ...contacts.map((c) => ({ style: c.style ?? 2, cells: c.cells }))];
  const about = [
    { style: 4, cells: ['DocLocker lenders - INTERNAL ONLY'] },
    { style: 5, cells: ['Do not forward outside the team. Contains lender contact details.'] },
    { cells: [''] },
    { style: 5, cells: [`Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from DocLocker (read-only). Source: ${SOURCE}.`] },
    { style: 5, cells: [`${rows.length} lender login(s) found; one row per contact. Highlighted rows are go-live lenders with no contact in DocLocker.`] },
    { cells: [''] },
    { style: 5, cells: ['Filled from DocLocker: Lender name, Email address (the login), and contact name where stored.'] },
    { style: 5, cells: ['Not stored in DocLocker - please fill in: Contact person name, Branch name and city, Branch address, Designation, Phone, Lender code, Products covered, Notes.'] },
    { style: 5, cells: ['A lender with more than one branch or contact gets a separate row for each.'] },
  ];

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Lenders" sheetId="1" r:id="rId1"/><sheet name="About" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Lenders!$A$1:$${colName(COLUMNS.length - 1)}$${lenders.length}</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': sheetXml(lenders, { widths: COLUMNS.map((c) => c[1]) }),
    'xl/worksheets/sheet2.xml': sheetXml(about, { widths: [110], header: false }),
  };

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(OUT);
    const zip = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, xml] of Object.entries(files)) zip.append(xml, { name });
    zip.finalize();
  });
  console.log(`Wrote ${OUT}: ${rows.length} lender contact(s).`);
}

main().catch((err) => { console.error('export-lenders failed:', err.message); process.exitCode = 1; }).finally(() => closeDb().catch(() => {}));
