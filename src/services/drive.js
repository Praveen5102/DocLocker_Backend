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


module.exports = {
  getDrive,
  ROOT_FOLDER_ID,
  sanitize,
  buildFolderKey,
  getOrCreate,
  findFolderByName,
  listFolders,
  listFilesInFolder,
  listAllFilesRecursive,
  shareFilePublicly,
  findFilesByName,
  readJsonFile,
  trashFile,
  trashFilesByName,
  createJsonFile,
  uploadBuffer,
};
