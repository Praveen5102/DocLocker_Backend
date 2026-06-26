const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByName, createJsonFile } = require('./drive');

async function readBanksFile() {
  const files = await findFilesByName(ROOT_FOLDER_ID(), 'banks.json');
  if (files.length === 0) return { banks: [] };
  try {
    const data = await readJsonFile(files[0].id);
    return data && Array.isArray(data.banks) ? data : { banks: [] };
  } catch (err) {
    console.warn('Failed to parse banks.json:', err.message);
    return { banks: [] };
  }
}

async function writeBanksFile(data) {
  await trashFilesByName(ROOT_FOLDER_ID(), 'banks.json');
  await createJsonFile(ROOT_FOLDER_ID(), 'banks.json', data);
}

module.exports = { readBanksFile, writeBanksFile };
