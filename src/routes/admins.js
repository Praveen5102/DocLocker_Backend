const express = require('express');
const { verifyJWT, requireStaff, requireCompanyAdmin } = require('../middleware/auth');
const { advisorsCache, studentsCache } = require('../services/cache');
const { logAudit } = require('../services/auditLog');
const { scopeOrgIds } = require('../services/tenantScope');
const { sessionPayload } = require('../services/session');
const accounts = require('../services/accounts');
const { getCompany } = require('../services/companies');

const router = express.Router();

// Who manages what is decided in services/accounts.js (canManage):
// superadmin → anyone; company admin → their company's admins, staff and
// lenders; staff (advisor) → their company's lenders; lenders → nobody.

function sendError(res, err, fallback = 'Internal server error') {
  if (err instanceof accounts.AccountError) return res.status(err.status).json({ success: false, error: err.message });
  console.error('accounts route error:', err.message);
  return res.status(500).json({ success: false, error: fallback });
}

async function loadManageable(req, res) {
  const target = await accounts.findById(req.params.id);
  // Outside the caller's companies it simply doesn't exist for them.
  const ids = await scopeOrgIds();
  if (!target || (ids && !ids.includes(target.orgId))) {
    res.status(404).json({ success: false, error: 'Account not found' });
    return null;
  }
  if (!accounts.canManage(req.admin, target)) {
    res.status(403).json({ success: false, error: 'You can’t manage this account' });
    return null;
  }
  return target;
}

// GET /api/admins?role=advisor — accounts in the caller's companies (admins)
router.get('/', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const role = accounts.ROLES.includes(req.query.role) ? [req.query.role] : null;
    const list = await accounts.listAccounts({ orgIds: await scopeOrgIds(), roles: role });
    res.json({ success: true, admins: list.map(accounts.publicAccount) });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admins/bankers — the company's lenders, for any staff member
// assigning access. Narrower than the full list: no other staff details.
router.get('/bankers', verifyJWT, requireStaff, async (req, res) => {
  try {
    const list = await accounts.listAccounts({ orgIds: await scopeOrgIds(), roles: ['banker'] });
    res.json({
      success: true,
      bankers: list.map((a) => ({
        id: a.id, name: a.name, bank: a.bank, email: a.email || '', status: a.status, createdAt: a.createdAt,
        company: { id: a.company.id, name: a.company.name },
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// PUT /api/admins/password — change your own password (any signed-in account).
// Must come before /:id routes. Returns a fresh session: the change signs out
// every other device.
router.put('/password', verifyJWT, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Enter your current and new password' });
    }
    const me = await accounts.findById(req.admin.id);
    const { valid } = await accounts.verifyPassword(currentPassword, me.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    const updated = await accounts.updateAccount(me.id, { password: newPassword });
    logAudit({ actor: me.name, role: me.role, action: 'admin.change_own_password', target: me.name });
    res.json(sessionPayload(updated));
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/admins { name, email, role, password, bank?, companyId? }
router.post('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { name, email, role, password, bank, companyId } = req.body || {};
    const orgId = req.admin.role === 'superadmin' && companyId ? companyId : req.admin.orgId;
    if (orgId !== req.admin.orgId && !(await getCompany(orgId))) {
      return res.status(404).json({ success: false, error: 'Company not found' });
    }
    if (!accounts.canManage(req.admin, { role, orgId })) {
      return res.status(403).json({ success: false, error: 'You can’t create this kind of account' });
    }
    const created = await accounts.createAccount({ orgId, name, email, role, bank, password, createdBy: req.admin.name });
    advisorsCache.clear();
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'admin.create', target: created.name, details: { role, email: created.email } });
    res.json({ success: true, account: accounts.publicAccount(created) });
  } catch (err) {
    sendError(res, err);
  }
});

// PUT /api/admins/:id { email?, bank?, role?, status? }
router.put('/:id', verifyJWT, requireStaff, async (req, res) => {
  try {
    const target = await loadManageable(req, res);
    if (!target) return;
    const { email, bank, role, status } = req.body || {};
    if (target.id === req.admin.id && (role !== undefined || status !== undefined)) {
      return res.status(400).json({ success: false, error: 'You can’t change your own role or status' });
    }
    if (role !== undefined && !accounts.canManage(req.admin, { role, orgId: target.orgId })) {
      return res.status(403).json({ success: false, error: 'You can’t give this role' });
    }
    const demoting = (role !== undefined && role !== 'superadmin') || status === 'disabled';
    if (demoting && (await accounts.isLastSuperadmin(target))) {
      return res.status(400).json({ success: false, error: 'This is the last active super admin' });
    }
    const updated = await accounts.updateAccount(target.id, { email, bank, role, status });
    advisorsCache.clear();
    studentsCache.clear();
    logAudit({
      orgId: target.orgId, actor: req.admin.name, role: req.admin.role, action: 'admin.update', target: target.name,
      details: {
        ...(email !== undefined ? { email: updated.email } : {}),
        ...(role !== undefined && role !== target.role ? { role, previousRole: target.role } : {}),
        ...(status !== undefined && status !== target.status ? { status } : {}),
        ...(bank !== undefined && bank !== target.bank ? { bank } : {}),
      },
    });
    res.json({ success: true, account: accounts.publicAccount(updated) });
  } catch (err) {
    sendError(res, err);
  }
});

// PUT /api/admins/:id/reset-password { newPassword }
router.put('/:id/reset-password', verifyJWT, requireStaff, async (req, res) => {
  try {
    const target = await loadManageable(req, res);
    if (!target) return;
    await accounts.updateAccount(target.id, { password: req.body?.newPassword });
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'admin.reset_password', target: target.name });
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// DELETE /api/admins/:id
router.delete('/:id', verifyJWT, requireStaff, async (req, res) => {
  try {
    if (req.params.id === req.admin.id) return res.status(400).json({ success: false, error: 'You can’t delete your own account' });
    const target = await loadManageable(req, res);
    if (!target) return;
    if (await accounts.isLastSuperadmin(target)) {
      return res.status(400).json({ success: false, error: 'This is the last active super admin' });
    }
    await accounts.deleteAccount(target.id);
    advisorsCache.clear();
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'admin.delete', target: target.name, details: { role: target.role } });
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
