// Application-level encryption for everything we store on Railway: student
// records in Postgres and documents in the bucket. Railway already encrypts
// at rest, but this means a leaked database dump or bucket credential still
// only exposes ciphertext — the key lives solely in the backend's env.
//
// Format of every encrypted value:
//   [1 byte version = 1][12 byte IV][16 byte GCM auth tag][ciphertext]
// The version byte leaves room to rotate keys/algorithms later.
//
// DATA_ENCRYPTION_KEY (32 random bytes, base64) is the single master key.
// Separate subkeys are derived per purpose with HKDF, so a record key can
// never be used to decrypt a document and vice versa.
//
// LOSING DATA_ENCRYPTION_KEY MAKES EVERY RAILWAY-STORED RECORD AND DOCUMENT
// UNREADABLE. It must be backed up somewhere safe outside Railway.

const crypto = require('crypto');

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PURPOSES = new Set(['records', 'files', 'backups']);

let masterKey = null;
const subkeys = new Map();

function getMasterKey() {
  if (masterKey) return masterKey;
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) throw new Error('DATA_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  masterKey = key;
  return masterKey;
}

function keyFor(purpose) {
  if (!PURPOSES.has(purpose)) throw new Error(`Unknown encryption purpose: ${purpose}`);
  if (!subkeys.has(purpose)) {
    const derived = crypto.hkdfSync('sha256', getMasterKey(), Buffer.alloc(0), `doclocker-${purpose}-v1`, 32);
    subkeys.set(purpose, Buffer.from(derived));
  }
  return subkeys.get(purpose);
}

function isEncryptionConfigured() {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

function encrypt(plaintext, purpose) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

function decrypt(payload, purpose) {
  if (!Buffer.isBuffer(payload) || payload.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted payload is malformed');
  }
  if (payload[0] !== VERSION) throw new Error(`Unsupported encryption version ${payload[0]}`);
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = payload.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

const encryptJson = (value) => encrypt(Buffer.from(JSON.stringify(value), 'utf8'), 'records');
const decryptJson = (payload) => JSON.parse(decrypt(payload, 'records').toString('utf8'));

module.exports = { encrypt, decrypt, encryptJson, decryptJson, isEncryptionConfigured };
