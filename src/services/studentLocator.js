// Finds a student's application by the email or mobile number they
// registered with — for signing in, resuming and the signup duplicate check.
//
// On a company link only that company's students are searched. On the main
// site, Flyurdream's students first (Railway, then Drive), then any active
// partner company's — the result then names that company.
const { ROOT_FOLDER_ID, listFolders, findFilesByName, findFolderByName, readJsonFile } = require('./drive');
const { findRailwayStudentByIdentifier } = require('./studentStore');
const { includesOwner, ownerOrgId, runWithScope, findCompanyBySlug } = require('./tenantScope');
const { getCompany, publicCompany } = require('./companies');
const { normalizeIndianMobile } = require('./contactValidation');

// student_meta.json now lives in the "Others" subfolder; older students may still
// have it sitting at the folder root from before this change, so check both —
// in parallel, to avoid doubling/tripling per-folder Drive round trips.
// The auto-generated Student_Summary.pdf / Eligibility_Report.pdf live in that
// same "Others" folder, so their lookup piggybacks on this same round trip
// instead of costing the list view a second Drive call per student.
async function findMetaFile(folderId) {
  const [othersDir, rootFiles] = await Promise.all([
    findFolderByName(folderId, 'Others'),
    findFilesByName(folderId, 'student_meta.json'),
  ]);
  if (!othersDir) {
    return { metaFiles: rootFiles, summaryFile: null, eligibilityFile: null };
  }
  const [inOthers, summaryFiles, eligibilityFiles] = await Promise.all([
    findFilesByName(othersDir.id, 'student_meta.json'),
    findFilesByName(othersDir.id, 'Student_Summary.pdf'),
    findFilesByName(othersDir.id, 'Eligibility_Report.pdf'),
  ]);
  return {
    metaFiles: inOthers.length > 0 ? inOthers : rootFiles,
    summaryFile: summaryFiles[0] || null,
    eligibilityFile: eligibilityFiles[0] || null,
  };
}

const emailKey = (v) => String(v || '').trim().toLowerCase();
const phoneKey = (v) => {
  const digits = normalizeIndianMobile(v).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};

// "Name@Mail.com " → { key: "name@mail.com", isEmail: true }; "+91 98…" → 10 digits.
// Shape only: older records predate today's stricter signup rules.
function parseIdentifier(raw) {
  const text = String(raw || '').trim();
  const isEmail = text.includes('@');
  const key = isEmail ? emailKey(text) : phoneKey(text);
  if (isEmail ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key) : key.length !== 10) return null;
  return { key, isEmail };
}

// Drive students' contact details (email + phone → folder), read from their
// meta files. Drive folders are named by email only, so a phone number can't
// be matched from the folder list alone. Read once shortly after start-up,
// then refreshed in the background every 10 minutes — a lookup never waits
// on that unless the list has never been read (new students go to Railway,
// so it only changes by edits).
const DRIVE_CONTACTS_TTL_MS = 10 * 60 * 1000;
const driveContacts = { at: 0, byKey: new Map(), building: null };

function buildDriveContacts() {
  if (!driveContacts.building) {
    driveContacts.building = (async () => {
      const folders = (await listFolders(ROOT_FOLDER_ID())).filter((f) => f.name);
      const byKey = new Map();
      await Promise.all(folders.map(async (folder) => {
        try {
          const { metaFiles } = await findMetaFile(folder.id);
          if (!metaFiles[0]) return;
          const meta = await readJsonFile(metaFiles[0].id);
          const e = emailKey(meta.email);
          const ph = phoneKey(meta.phone);
          if (e && !byKey.has(e)) byKey.set(e, folder);
          if (ph && !byKey.has(ph)) byKey.set(ph, folder);
        } catch (_) { /* one unreadable folder never blocks the rest */ }
      }));
      driveContacts.byKey = byKey;
      if (!driveContacts.at) console.log(`[find] Drive contacts ready (${folders.length} folders)`);
      driveContacts.at = Date.now();
    })().catch((err) => console.error('[find] reading Drive contacts failed:', err.message))
      .finally(() => { driveContacts.building = null; });
  }
  return driveContacts.building;
}

function warmDriveContacts() {
  setTimeout(() => buildDriveContacts(), 15 * 1000).unref();
}

// Folder names keep the email as typed at signup (sometimes with capitals,
// sometimes with "@" turned into "_"), so compare loosely.
async function findDriveFolderByName(email) {
  const folders = await listFolders(ROOT_FOLDER_ID());
  const suffixes = [`__${email}`, `__${email.replace(/[^a-z0-9 _\-.]/g, '_')}`];
  return folders.find((f) => f.name && suffixes.some((x) => f.name.toLowerCase().endsWith(x))) || null;
}

async function findDriveFolderByContacts(key) {
  if (!driveContacts.at) await buildDriveContacts();
  else if (Date.now() - driveContacts.at > DRIVE_CONTACTS_TTL_MS) buildDriveContacts();
  return driveContacts.byKey.get(key) || null;
}

async function driveStudentMeta(folder) {
  const displayName = folder.name.split('__')[0] || folder.name;
  let studentData = { name: displayName, driveUrl: folder.webViewLink };
  try {
    const { metaFiles } = await findMetaFile(folder.id);
    if (metaFiles.length > 0) {
      const meta = await readJsonFile(metaFiles[0].id);
      studentData = { driveUrl: folder.webViewLink, ...meta, name: meta.name || displayName };
    }
  } catch (_) {}
  return studentData;
}

// Runs inside the request's company scope (studentCompany middleware).
// → { studentKey, orgId, student, company } | null
//   student: the full record — only ever returned to a signed-in applicant.
//   company: set when the student belongs to a partner company found from
//            the main site.
async function locateStudent({ key, isEmail }, { viaCompanyLink, companyId }) {
  const railway = await findRailwayStudentByIdentifier(key, { withOrg: true });
  if (railway) return { studentKey: railway.student.studentKey, orgId: railway.orgId, student: railway.student, company: null };

  // A Drive hiccup must not stop students stored elsewhere from being
  // found; it only matters (and is reported) when nothing else matched.
  let driveError = null;
  const fromDrive = async (find) => {
    try {
      const folder = await find();
      return folder ? { studentKey: folder.name, orgId: await ownerOrgId(), student: await driveStudentMeta(folder), company: null } : null;
    } catch (err) {
      driveError = err;
      return null;
    }
  };

  const withDrive = await includesOwner();
  if (withDrive && isEmail) {
    const hit = await fromDrive(() => findDriveFolderByName(key));
    if (hit) return hit;
  }

  if (!viaCompanyLink) {
    const found = await runWithScope({ orgIds: null, homeOrgId: companyId },
      () => findRailwayStudentByIdentifier(key, { withOrg: true }));
    if (found && found.orgId !== companyId) {
      const org = await getCompany(found.orgId);
      const live = org && await findCompanyBySlug(org.slug);
      if (live && live.status === 'active') {
        return { studentKey: found.student.studentKey, orgId: found.orgId, student: found.student, company: publicCompany(live) };
      }
    }
  }

  if (withDrive) {
    const hit = await fromDrive(() => findDriveFolderByContacts(key));
    if (hit) return hit;
  }
  if (driveError) throw driveError;
  return null;
}

module.exports = { parseIdentifier, locateStudent, findMetaFile, warmDriveContacts, emailKey, phoneKey };
