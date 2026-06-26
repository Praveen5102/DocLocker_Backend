const jwt = require('jsonwebtoken');

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

// Same as verifyJWT, but also accepts the token via ?token= query param.
// Needed for endpoints loaded directly by the browser as a resource URL
// (<img src>, <iframe src>, download links) where we can't attach a custom
// Authorization header.
function verifyJWTFlexible(req, res, next) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ')) ? header.split(' ')[1] : req.query.token;
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

module.exports = { verifyJWT, verifyJWTFlexible, requireSuperAdmin, requireStaff };
