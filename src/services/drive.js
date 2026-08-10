const { google } = require('googleapis');
const { Readable } = require('stream');

let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN in .env');
  }
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  _drive = google.drive({ version: 'v3', auth: oauth2 });
  return _drive;
}

const ROOT_FOLDER_ID = () => {
  if (!process.env.ROOT_FOLDER_ID) throw new Error('ROOT_FOLDER_ID env var not set');
  return process.env.ROOT_FOLDER_ID;
};

function sanitize(name) {
  return (String(name || 'Unknown').replace(/[^a-zA-Z0-9 _\-.]/g, '_').trim() || 'Unknown');
}

// Mirrors Frontend/src/utils/driveApi.js's buildFolderKey — student folders are
// named "{name}__{identifier}" when an identifier (email/phone) is known, so
// any backend lookup by name alone must reconstruct the same key or it won't
// find the folder (and getOrCreate would silently create an empty duplicate).
function buildFolderKey(name, identifier = '') {
  const safeName = (name || 'Unknown').trim();
  const safeId = (identifier || '').trim().replace(/[^a-zA-Z0-9@._+-]/g, '');
  return safeId ? `${safeName}__${safeId}` : safeName;
}

// Sanitize a folderKey without stripping @ from the identifier portion.
// sanitize() treats @ as an illegal char and replaces it with _, which breaks
// email-based folder lookup. This function only sanitizes the name part (before __).
function cleanFolderKey(key) {
  const k = String(key || '');
  const sep = k.indexOf('__');
  return sep >= 0 ? sanitize(k.slice(0, sep)) + '__' + k.slice(sep + 2) : sanitize(k);
}

// Extract the display name (part before __) from a folderKey, sanitized.
function folderKeyDisplayName(key) {
  const k = String(key || '');
  const sep = k.indexOf('__');
  return sanitize(sep >= 0 ? k.slice(0, sep) : k);
}

function escapeQ(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getOrCreate(parentId, name) {
  const drive = getDrive();
  const safeName = sanitize(name);
  const res = await drive.files.list({
    q: `name = '${escapeQ(safeName)}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 5,
  });
  if (res.data.files.length > 0) return res.data.files[0];
  const created = await drive.files.create({
    requestBody: { name: safeName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id, name',
  });
  return created.data;
}

// Read-only lookup — unlike getOrCreate, never creates the folder as a side effect.
// Returns the folder { id, name } or null if it doesn't exist.
async function findFolderByName(parentId, name) {
  const drive = getDrive();
  const safeName = sanitize(name);
  const res = await drive.files.list({
    q: `name = '${escapeQ(safeName)}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 1,
  });
  return res.data.files.length > 0 ? res.data.files[0] : null;
}

async function listFolders(parentId) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, webViewLink)',
    spaces: 'drive',
    pageSize: 1000,
  });
  return res.data.files || [];
}

// Files (not folders) directly inside a folder.
async function listFilesInFolder(parentId) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, mimeType, size, webViewLink)',
    spaces: 'drive',
    pageSize: 1000,
  });
  return res.data.files || [];
}

// Grants "anyone with the link can view" on a single file — used for sharing
// specific documents with an external party (e.g. a bank) without exposing
// the rest of the student's folder.
async function shareFilePublicly(fileId) {
  const drive = getDrive();
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    fields: 'id',
  });
}

// Walks every subfolder under rootFolderId and returns a flat list of every
// file found, each tagged with the relative folder path it came from.
async function listAllFilesRecursive(rootFolderId, relativePath = '') {
  const [files, subfolders] = await Promise.all([
    listFilesInFolder(rootFolderId),
    listFolders(rootFolderId),
  ]);

  let all = files.map((f) => ({ ...f, relativePath }));

  const nested = await Promise.all(
    subfolders.map((sub) =>
      listAllFilesRecursive(sub.id, relativePath ? `${relativePath}/${sub.name}` : sub.name),
    ),
  );
  for (const list of nested) all = all.concat(list);

  return all;
}

async function findFilesByName(parentId, name) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `name = '${escapeQ(name)}' and '${parentId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 10,
  });
  return res.data.files || [];
}

async function readFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data).toString('utf-8');
}

async function readFileBuffer(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function readJsonFile(fileId) {
  const text = await readFile(fileId);
  return JSON.parse(text);
}

async function trashFile(fileId) {
  const drive = getDrive();
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

async function trashFilesByName(parentId, name) {
  const files = await findFilesByName(parentId, name);
  await Promise.all(files.map((f) => trashFile(f.id)));
}

// Permanently deletes a file or folder — bypasses Drive's Trash entirely.
// For a folder, Drive cascades the delete to everything nested inside it, so
// a student's whole tree (subfolders, documents, meta JSON) is removed in one
// call. Unlike trashFile(), this is NOT recoverable and does not keep
// counting against Drive storage quota — used for genuine hard-delete flows.
async function deletePermanently(fileId) {
  const drive = getDrive();
  await drive.files.delete({ fileId });
}

async function createJsonFile(parentId, name, data) {
  const drive = getDrive();
  const content = JSON.stringify(data);
  const res = await drive.files.create({
    requestBody: { name, mimeType: 'application/json', parents: [parentId] },
    media: { mimeType: 'application/json', body: Readable.from(Buffer.from(content, 'utf-8')) },
    fields: 'id, name',
  });
  return res.data;
}

async function uploadBuffer(parentId, filename, mimeType, buffer) {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

async function getFileMeta(fileId) {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, fields: 'id, name, mimeType, parents' });
  return res.data;
}

// Walks a file's ancestors up to ROOT_FOLDER_ID and returns the name of the
// student folder it lives under (the folder whose direct parent is root),
// or null if the file isn't under a recognizable student folder at all.
// Used to authorize banker access to a single file without exposing the
// whole Drive tree.
async function findStudentFolderKeyForFile(fileId) {
  const root = ROOT_FOLDER_ID();
  let current = await getFileMeta(fileId);
  for (let depth = 0; depth < 6; depth++) {
    const parentId = current.parents && current.parents[0];
    if (!parentId) return null;
    if (parentId === root) return current.name;
    current = await getFileMeta(parentId);
  }
  return null;
}

// Streams raw file bytes straight from Drive — used by the secure proxy
// endpoint so bankers/staff never need direct Drive permissions; access is
// gated entirely by our own JWT + folder-ownership check before this is called.
async function getFileContentStream(fileId) {
  const drive = getDrive();
  const meta = await getFileMeta(fileId);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return { stream: res.data, mimeType: meta.mimeType, name: meta.name };
}


module.exports = {
  getDrive,
  ROOT_FOLDER_ID,
  sanitize,
  buildFolderKey,
  cleanFolderKey,
  folderKeyDisplayName,
  getOrCreate,
  findFolderByName,
  listFolders,
  listFilesInFolder,
  listAllFilesRecursive,
  shareFilePublicly,
  findFilesByName,
  readJsonFile,
  readFileBuffer,
  trashFile,
  trashFilesByName,
  deletePermanently,
  createJsonFile,
  uploadBuffer,
  getFileMeta,
  findStudentFolderKeyForFile,
  getFileContentStream,
};
