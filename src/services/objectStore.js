// Railway Bucket (S3-compatible) storage for student documents.
//
// - Every object is encrypted with dataCrypto before it leaves the backend,
//   so the bucket only ever holds ciphertext.
// - Object keys contain IDs only (orgs/<org>/students/<student>/<document>),
//   never names, emails or file names — nothing personal leaks through a
//   bucket listing.
// - Reads verify the plaintext SHA-256 recorded at upload, so silent
//   corruption or a swapped object is caught instead of served.
//
// Dormant unless the BUCKET_* variables are set.

const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { encrypt, decrypt } = require('./dataCrypto');

let client = null;

function isBucketEnabled() {
  return Boolean(
    process.env.BUCKET_NAME &&
    process.env.BUCKET_ENDPOINT &&
    process.env.BUCKET_ACCESS_KEY_ID &&
    process.env.BUCKET_SECRET_ACCESS_KEY,
  );
}

function getClient() {
  if (!isBucketEnabled()) throw new Error('Bucket is not configured (BUCKET_* variables missing)');
  if (!client) {
    client = new S3Client({
      endpoint: process.env.BUCKET_ENDPOINT,
      region: process.env.BUCKET_REGION || 'auto',
      forcePathStyle: process.env.BUCKET_URL_STYLE === 'path',
      credentials: {
        accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
        secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

function documentKey({ orgId, studentId, documentId }) {
  return `orgs/${orgId}/students/${studentId}/${documentId}`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function putEncrypted(key, plaintext) {
  const body = encrypt(plaintext, 'files');
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
  }));
  return { sha256: sha256(plaintext), sizeBytes: plaintext.length, encryption: 'aes-256-gcm-v1' };
}

async function getRaw(key) {
  const res = await getClient().send(new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function getDecrypted(key, expectedSha256) {
  const plaintext = decrypt(await getRaw(key), 'files');
  if (expectedSha256 && sha256(plaintext) !== expectedSha256) {
    throw new Error(`Integrity check failed for object ${key}`);
  }
  return plaintext;
}

async function deleteObject(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }));
}

module.exports = { isBucketEnabled, documentKey, putEncrypted, getDecrypted, getRaw, deleteObject };
