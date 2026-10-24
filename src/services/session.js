const jwt = require('jsonwebtoken');
const { publicAccount } = require('./accounts');

// A token only names the account and its token version; everything else is
// looked up per request (middleware/auth.js). Setup tokens (superadmin
// signed in by name to add an email) are short-lived and can do nothing else.
function signToken(account, { setup = false } = {}) {
  return jwt.sign(
    { sub: account.id, tv: account.tokenVersion, ...(setup ? { setup: true } : {}) },
    process.env.JWT_SECRET,
    { expiresIn: setup ? '15m' : '8h' },
  );
}

function sessionPayload(account, { setup = false } = {}) {
  return {
    success: true,
    token: signToken(account, { setup }),
    setupRequired: setup,
    account: publicAccount(account),
    // Fields older screens still read
    role: account.role,
    name: account.name,
    advisorName: account.role === 'advisor' ? account.name : '',
    bank: account.role === 'banker' ? account.bank : '',
  };
}

module.exports = { signToken, sessionPayload };
