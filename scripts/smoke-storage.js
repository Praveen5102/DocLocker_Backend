// npm run test:storage — end-to-end check of the Railway storage foundation
// against the configured DATABASE_URL and bucket (use the dev ones locally).
// Creates a throwaway student + document, verifies encryption both ways,
// then removes everything it created.
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, closeDb } = require('../src/db');
const { runMigrations } = require('../src/db/migrate');
const { encryptJson, decryptJson } = require('../src/services/dataCrypto');
const { documentKey, putEncrypted, getDecrypted, getRaw, deleteObject } = require('../src/services/objectStore');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const results = [];
const check = (name, fn) => results.push(Promise.resolve().then(fn).then(() => `PASS  ${name}`, (e) => `FAIL  ${name}: ${e.message}`));

(async () => {
  if (!/student-documents-dev/.test(process.env.BUCKET_NAME || '')) {
    console.error('Refusing to run: BUCKET_NAME is not the dev bucket.');
    process.exit(1);
  }

  let studentId;
  let key;
  try {
    // 1. Migrations: apply, then a second run must be a no-op.
    await runMigrations({ log: () => {} });
    const again = await runMigrations({ log: () => {} });
    assert.strictEqual(again.length, 0, 'second migration run should apply nothing');
    results.push('PASS  migrations apply and are idempotent');

    const { rows: [org] } = await query("SELECT id FROM organizations WHERE slug = 'flyurdream'");
    assert.ok(org, 'flyurdream organisation should be seeded');

    // 2. Encrypted student record round trip.
    const record = { name: 'Smoke Test', personalInfo: { aadhaarNumber: 'XXXX XXXX 1234', panNumber: 'ABCPR1234K' } };
    const { rows: [stu] } = await query(
      `INSERT INTO students (org_id, folder_key, name, identifier, email, record_enc)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, record_enc`,
      [org.id, `Smoke_Test__smoke-${Date.now()}@example.com`, 'Smoke Test', 'smoke@example.com', 'smoke@example.com', encryptJson(record)],
    );
    studentId = stu.id;
    assert.deepStrictEqual(decryptJson(stu.record_enc), record);
    assert.ok(!stu.record_enc.toString('latin1').includes('ABCPR1234K'), 'PAN must not appear in stored bytes');
    results.push('PASS  student record stored encrypted and decrypts intact');

    // 3–5. Encrypted document round trip in the dev bucket.
    const plaintext = Buffer.from(`%PDF-1.4 smoke test PASSPORT Z1234567 ${crypto.randomUUID()}`);
    key = documentKey({ orgId: org.id, studentId, documentId: crypto.randomUUID() });
    const meta = await putEncrypted(key, plaintext);
    await query(
      `INSERT INTO documents (org_id, student_id, section, file_name, mime_type, size_bytes, storage, storage_key, encryption, sha256)
       VALUES ($1, $2, 'GOVT ID', 'Passport.pdf', 'application/pdf', $3, 'bucket', $4, $5, $6)`,
      [org.id, studentId, meta.sizeBytes, key, meta.encryption, meta.sha256],
    );

    const back = await getDecrypted(key, meta.sha256);
    assert.ok(back.equals(plaintext), 'decrypted file must equal the original');
    results.push('PASS  document uploaded encrypted and reads back byte-for-byte');

    const raw = await getRaw(key);
    assert.ok(!raw.toString('latin1').includes('PASSPORT'), 'raw bucket object must not contain plaintext');
    assert.ok(!raw.toString('latin1').includes('%PDF'), 'raw bucket object must not look like a PDF');
    results.push('PASS  raw bucket object is ciphertext only (no plaintext)');

    assert.ok(!key.includes('Smoke') && !key.includes('Passport'), 'object key must not contain personal data');
    results.push('PASS  object key holds IDs only');

    // Tamper: overwrite the object with flipped bytes — reading must fail.
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 1] ^= 0xff;
    const s3 = new S3Client({
      endpoint: process.env.BUCKET_ENDPOINT,
      region: process.env.BUCKET_REGION || 'auto',
      forcePathStyle: process.env.BUCKET_URL_STYLE === 'path',
      credentials: { accessKeyId: process.env.BUCKET_ACCESS_KEY_ID, secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY },
    });
    await s3.send(new PutObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key, Body: tampered }));
    await assert.rejects(() => getDecrypted(key, meta.sha256), 'tampered object must be rejected');
    results.push('PASS  tampered object is rejected');
  } catch (err) {
    results.push(`FAIL  ${err.message}`);
  } finally {
    // Clean up everything this test created.
    if (key) await deleteObject(key).catch(() => {});
    if (studentId) await query('DELETE FROM students WHERE id = $1', [studentId]).catch(() => {});
    await closeDb();
  }

  const lines = await Promise.all(results);
  console.log(lines.join('\n'));
  process.exitCode = lines.some((l) => l.startsWith('FAIL')) ? 1 : 0;
})();
