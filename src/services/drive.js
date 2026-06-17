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
  getOrCreate,
  findFolderByName,
  listFolders,
  findFilesByName,
  readJsonFile,
  trashFile,
  trashFilesByName,
  createJsonFile,
  uploadBuffer,
};
