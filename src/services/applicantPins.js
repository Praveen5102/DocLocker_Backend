// Applicant PINs and applicant sessions.
//
// A student signs in with their email or mobile number plus a 6-digit PIN
// they chose at registration. Five wrong PINs lock the application for 15
// minutes. Staff can reset a forgotten PIN; the student then picks a new
// one on their next visit. Sessions are JWTs with their own audience, so
// an applicant token is never accepted as a staff token or the other way
// round, and they carry the PIN version, so a reset ends every session.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');

const AUDIENCE = 'applicant';
const SESSION_TTL = '7d';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function pinProblem(pin) {
  const p = String(pin ?? '');
  if (!/^\d{6}$/.test(p)) return 'Your PIN must be exactly 6 digits';
  if (/^(\d)\1{5}$/.test(p)) return 'Choose a PIN that isn’t one digit repeated';
  if ('0123456789'.includes(p) || '9876543210'.includes(p)) return 'Choose a PIN that isn’t a simple sequence like 123456';
  return null;
}

async function getPinRow(orgId, studentKey) {
  const { rows } = await query(
    'SELECT pin_hash, pin_version, failed_count, locked_until FROM applicant_pins WHERE org_id = $1 AND student_key = $2',
    [orgId, studentKey],
  );
  return rows[0] || null;
}

const hasPin = async (orgId, studentKey) => Boolean((await getPinRow(orgId, studentKey))?.pin_hash);

// Sets the PIN. onlyIfUnset: succeed only when there is no PIN yet (first
// visit after an upgrade or a staff reset) — checked in the same statement,
// so two people racing to claim an application can't both win.
// Returns the new pin_version, or null when a PIN was already set.
async function setPin(orgId, studentKey, pin, { onlyIfUnset = false } = {}) {
  const hash = await bcrypt.hash(String(pin), 10);
  const { rows } = await query(
    `INSERT INTO applicant_pins (org_id, student_key, pin_hash, set_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (org_id, student_key) DO UPDATE
       SET pin_hash = EXCLUDED.pin_hash, pin_version = applicant_pins.pin_version + 1,
           failed_count = 0, locked_until = NULL, set_at = now(), updated_at = now()
     ${onlyIfUnset ? 'WHERE applicant_pins.pin_hash IS NULL' : ''}
     RETURNING pin_version`,
    [orgId, studentKey, hash],
  );
  return rows[0] ? rows[0].pin_version : null;
}

// → { ok, version } | { noPin } | { locked, minutes } | { wrong, attemptsLeft }
async function checkPin(orgId, studentKey, pin) {
  const row = await getPinRow(orgId, studentKey);
  if (!row?.pin_hash) return { noPin: true };
  const now = Date.now();
  if (row.locked_until && new Date(row.locked_until).getTime() > now) {
    return { locked: true, minutes: Math.ceil((new Date(row.locked_until).getTime() - now) / 60000) };
  }
  if (await bcrypt.compare(String(pin ?? ''), row.pin_hash)) {
    if (row.failed_count) {
      await query('UPDATE applicant_pins SET failed_count = 0, locked_until = NULL WHERE org_id = $1 AND student_key = $2', [orgId, studentKey]);
    }
    return { ok: true, version: row.pin_version };
  }
  const failed = row.failed_count + 1;
  if (failed >= MAX_FAILED) {
    await query(
      `UPDATE applicant_pins SET failed_count = 0, locked_until = now() + interval '${LOCK_MINUTES} minutes', updated_at = now()
        WHERE org_id = $1 AND student_key = $2`,
      [orgId, studentKey],
    );
    return { locked: true, minutes: LOCK_MINUTES };
  }
  await query('UPDATE applicant_pins SET failed_count = $3, updated_at = now() WHERE org_id = $1 AND student_key = $2', [orgId, studentKey, failed]);
  return { wrong: true, attemptsLeft: MAX_FAILED - failed };
}

// Staff reset: the PIN is cleared and every session ends.
async function resetPin(orgId, studentKey) {
  await query(
    `INSERT INTO applicant_pins (org_id, student_key, pin_hash, pin_version) VALUES ($1, $2, NULL, 2)
     ON CONFLICT (org_id, student_key) DO UPDATE
       SET pin_hash = NULL, pin_version = applicant_pins.pin_version + 1,
           failed_count = 0, locked_until = NULL, updated_at = now()`,
    [orgId, studentKey],
  );
}

function signApplicantToken({ orgId, studentKey, version }) {
  return jwt.sign({ org: orgId, sk: studentKey, pv: version }, process.env.JWT_SECRET, { audience: AUDIENCE, expiresIn: SESSION_TTL });
}

// The session's claims, or null for a missing / invalid / staff token.
function readApplicantToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const claims = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET, { audience: AUDIENCE });
    return claims.org && claims.sk ? claims : null;
  } catch {
    return null;
  }
}

module.exports = {
  pinProblem, hasPin, setPin, checkPin, resetPin, getPinRow,
  signApplicantToken, readApplicantToken, AUDIENCE,
};
