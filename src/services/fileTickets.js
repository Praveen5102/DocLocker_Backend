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
const { currentScope } = require('./tenantScope');

const TTL_SECONDS = 120;
const used = new Map(); // jti -> expiry (ms)

function ticketSecret() {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('doclocker-file-ticket-v1').digest();
}

function sweep() {
  const now = Date.now();
  for (const [jti, exp] of used) if (exp < now) used.delete(jti);
}

// kind: 'file' | 'zip' | 'bundle'; target: the file id, student key or bundle id.
// The holder's account (re-checked on use) and the company scope the link
// was issued under travel with it.
function issueTicket({ kind, target, admin }) {
  const scope = currentScope();
  return jwt.sign(
    {
      k: kind, tg: target, sub: admin.id, tv: admin.tokenVersion, jti: crypto.randomUUID(),
      sc: scope ? { o: scope.orgIds, h: scope.homeOrgId } : null,
    },
    ticketSecret(),
    { expiresIn: TTL_SECONDS },
  );
}

// Returns { id, tv, scope } of whoever the ticket was issued to, or null if
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
  if (!claims.sub) return null;
  return { id: claims.sub, tv: claims.tv, scope: claims.sc ? { orgIds: claims.sc.o, homeOrgId: claims.sc.h } : null };
}

module.exports = { issueTicket, redeemTicket, TTL_SECONDS };
