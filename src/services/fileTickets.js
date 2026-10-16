// One-time download tickets.
//
// A browser download (a plain link the browser navigates to) can't carry an
// Authorization header, so it needs something in the URL. That used to be
// the caller's full login token — valid for 8 hours and for the whole API,
// so a forwarded link handed over the account. A ticket instead:
//   - opens exactly one file (or one student's zip), nothing else
//   - expires after 2 minutes
//   - works once — a second use is refused
//   - is signed with a key derived separately from the login key, so it
//     can never be used as a login token, and a login token can't be used
//     as a ticket
//
// Used tickets are remembered in memory until they expire, which matches
// the single-instance assumption made elsewhere (see drive.js createLock).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TTL_SECONDS = 120;
const used = new Map(); // jti -> expiry (ms)

function ticketSecret() {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('doclocker-file-ticket-v1').digest();
}

function sweep() {
  const now = Date.now();
  for (const [jti, exp] of used) if (exp < now) used.delete(jti);
}

// kind: 'file' | 'zip'; target: the file id or the student key.
function issueTicket({ kind, target, admin }) {
  return jwt.sign(
    { k: kind, tg: target, name: admin.name, role: admin.role, jti: crypto.randomUUID() },
    ticketSecret(),
    { expiresIn: TTL_SECONDS },
  );
}

// Returns { name, role } of whoever the ticket was issued to, or null if
// it's invalid, expired, for something else, or already used.
function redeemTicket(token, { kind, target }) {
  let claims;
  try {
    claims = jwt.verify(String(token || ''), ticketSecret());
  } catch {
    return null;
  }
  if (claims.k !== kind || claims.tg !== target) return null;
  sweep();
  if (used.has(claims.jti)) return null;
  used.set(claims.jti, claims.exp * 1000);
  return { name: claims.name, role: claims.role };
}

module.exports = { issueTicket, redeemTicket, TTL_SECONDS };
