const crypto = require('crypto');
const express = require('express');
const { isDbEnabled } = require('../db');
const { logAudit } = require('../services/auditLog');
const { verifyJWT } = require('../middleware/auth');
const { ownerOrgId } = require('../services/tenantScope');
const accounts = require('../services/accounts');
const { sessionPayload } = require('../services/session');

const router = express.Router();

// Compared against when no account matches, so a wrong email takes as long
// as a wrong password and response times don't reveal which emails exist.
const dummyHash = accounts.hashPassword(crypto.randomUUID());
const INVALID = 'Incorrect email or password';

function needDb(res) {
  if (isDbEnabled()) return false;
  res.status(503).json({ success: false, error: 'Sign-in is unavailable: the database is not configured' });
  return true;
}

// POST /api/auth/login  { email, password }
router.post('/login', async (req, res) => {
  try {
    if (needDb(res)) return;
    const login = String(req.body?.email || req.body?.name || '').trim();
    const password = String(req.body?.password || '');
    if (!login || !password) return res.status(400).json({ success: false, error: 'Enter your email and password' });

    if ((await accounts.countAccounts()) === 0) return res.json({ success: false, notInitialized: true });

    // Email sign-in for everyone. The only name sign-in left is a superadmin
    // whose account was imported without an email — once, to add one.
    let account = login.includes('@') ? await accounts.findByEmail(login) : await accounts.findByName(login);
    const nameBootstrap = account && !login.includes('@');
    if (nameBootstrap && !(account.role === 'superadmin' && !account.email)) account = null;

    if (!account) {
      await accounts.verifyPassword(password, await dummyHash);
      return res.status(401).json({ success: false, error: INVALID });
    }

    const lockedFor = accounts.lockedMinutesLeft(account);
    if (lockedFor) {
      return res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${lockedFor} minute${lockedFor === 1 ? '' : 's'}.` });
    }

    const { valid, needsUpgrade } = await accounts.verifyPassword(password, account.passwordHash);
    if (!valid) {
      await accounts.recordFailedLogin(account);
      logAudit({ orgId: account.orgId, actor: account.name, role: account.role, action: 'auth.login_failed', target: account.name });
      return res.status(401).json({ success: false, error: INVALID });
    }
    if (account.status !== 'active') return res.status(403).json({ success: false, error: 'This account has been disabled. Contact your admin.' });
    if (account.company.status !== 'active') return res.status(403).json({ success: false, error: 'Your company’s access is suspended. Contact Flyurdream.' });
    if (!account.email && !nameBootstrap) {
      return res.status(403).json({ success: false, error: 'Your account has no email yet. Ask your admin to add one.' });
    }

    await accounts.recordLogin(account, needsUpgrade ? { passwordHash: await accounts.hashPassword(password) } : {});
    logAudit({ orgId: account.orgId, actor: account.name, role: account.role, action: 'auth.login', target: account.name });
    res.json(sessionPayload(account, { setup: nameBootstrap }));
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/auth/init — first-time bootstrap: the very first superadmin.
router.post('/init', async (req, res) => {
  try {
    if (needDb(res)) return;
    if ((await accounts.countAccounts()) > 0) {
      return res.json({ success: false, error: 'System already initialized. Please sign in.' });
    }
    const account = await accounts.createAccount({
      orgId: await ownerOrgId(),
      name: req.body?.name, email: req.body?.email, password: req.body?.password,
      role: 'superadmin', createdBy: 'setup',
    });
    logAudit({ orgId: account.orgId, actor: account.name, role: account.role, action: 'admin.create', target: account.name, details: { role: 'superadmin' } });
    res.json(sessionPayload(account));
  } catch (err) {
    if (err instanceof accounts.AccountError) return res.status(err.status).json({ success: false, error: err.message });
    console.error('Init error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/auth/me — who is signed in (refreshes role/company on the client)
router.get('/me', verifyJWT, async (req, res) => {
  const account = await accounts.findById(req.admin.id);
  res.json({ success: true, account: accounts.publicAccount(account), setupRequired: req.admin.setup });
});

// PUT /api/auth/me/email { email, password } — add or change your own email.
// Also how a name-only superadmin finishes their one-time setup sign-in.
router.put('/me/email', verifyJWT, async (req, res) => {
  try {
    const account = await accounts.findById(req.admin.id);
    const { valid } = await accounts.verifyPassword(String(req.body?.password || ''), account.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'Your password is incorrect' });
    const updated = await accounts.updateAccount(account.id, { email: req.body?.email });
    logAudit({ actor: account.name, role: account.role, action: 'admin.change_own_email', target: account.name });
    res.json(sessionPayload(updated));
  } catch (err) {
    if (err instanceof accounts.AccountError) return res.status(err.status).json({ success: false, error: err.message });
    console.error('Email update error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
