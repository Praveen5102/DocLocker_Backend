const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ROOT_FOLDER_ID, findFilesByName, readJsonFile, trashFilesByName, createJsonFile } = require('./drive');

const BCRYPT_ROUNDS = 12;

// Detects an old unsalted SHA-256 hex string so we can migrate transparently.
function isLegacySha256(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
}

function legacySha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Hash a new password with bcrypt.
async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

// Verify a password against a stored hash.
// If the stored hash is legacy SHA-256, falls back to that comparison.
// Returns { valid: boolean, needsUpgrade: boolean }.
// Callers should re-hash with hashPassword() when needsUpgrade is true.
async function verifyPassword(plain, storedHash) {
  if (isLegacySha256(storedHash)) {
    const valid = legacySha256(plain) === storedHash;
    return { valid, needsUpgrade: valid };
  }
  const valid = await bcrypt.compare(plain, storedHash);
  return { valid, needsUpgrade: false };
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

module.exports = { hashPassword, verifyPassword, readAdminsFile, writeAdminsFile };
