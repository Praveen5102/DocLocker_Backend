const crypto = require('crypto');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByName, createJsonFile } = require('./drive');

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

async function readAdminsFile() {
  const files = await findFilesByName(ROOT_FOLDER_ID(), 'admins.json');
  if (files.length === 0) return null;
  try {
    return await readJsonFile(files[0].id);
  } catch (err) {
    console.warn('Failed to parse admins.json:', err.message);
    return null;
  }
}

async function writeAdminsFile(data) {
  await trashFilesByName(ROOT_FOLDER_ID(), 'admins.json');
  await createJsonFile(ROOT_FOLDER_ID(), 'admins.json', data);
}

module.exports = { sha256, readAdminsFile, writeAdminsFile };
