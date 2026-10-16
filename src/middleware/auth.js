const jwt = require('jsonwebtoken');
const { redeemTicket } = require('../services/fileTickets');

function verifyJWT(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  try {
    req.admin = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Superadmin access required' });
  }
  next();
}

// Blocks banker accounts from write/management endpoints — bankers are
// read-only viewers of the students they've been granted access to.
function requireStaff(req, res, next) {
  if (req.admin?.role === 'banker') {
    return res.status(403).json({ success: false, error: 'Not available to bank accounts' });
  }
  next();
}

// For endpoints a browser may load as a plain link (file downloads, zip).
// Accepts either the normal Authorization header (in-app fetches) or a
// one-time ticket for exactly this resource (?ticket=…, see
// services/fileTickets.js). A full login token in the URL is NOT accepted —
// a forwarded link must never hand over the account.
// targetOf(req) names the resource the ticket must have been issued for.
function verifyJWTOrTicket(kind, targetOf) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return verifyJWT(req, res, next);
    if (!req.query.ticket) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }
    const holder = redeemTicket(req.query.ticket, { kind, target: targetOf(req) });
    if (!holder) {
      return res.status(401).json({ success: false, error: 'This download link has expired or was already used. Start the download again from DocLocker.' });
    }
    req.admin = holder;
    req.viaTicket = true;
    next();
  };
}

module.exports = { verifyJWT, verifyJWTOrTicket, requireSuperAdmin, requireStaff };
