const express = require('express');
const { verifyJWT, requireStaff, requireSuperAdmin } = require('../middleware/auth');
const { advisorsCache } = require('../services/cache');
const { listAccounts, findById, setActsAsAdvisor } = require('../services/accounts');
const { scopeOrgIds } = require('../services/tenantScope');
const { logAudit } = require('../services/auditLog');

const router = express.Router();

// GET /api/advisors — the active staff of the caller's own company (a
// superadmin: every company), for the dashboard's advisor pickers. A
// superadmin who chose to work as an advisor too (PUT /me) is included;
// superadmins belong to the owner company, so partners never see them.
// Signed-in only: students no longer choose an advisor, so staff names
// aren't exposed publicly at all.
router.get('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    if (advisorsCache.isValid()) {
      return res.json({ success: true, advisors: advisorsCache.data });
    }
    const people = await listAccounts({ orgIds: await scopeOrgIds(), roles: ['advisor', 'superadmin'] });
    const advisors = people
      .filter((a) => a.status === 'active' && (a.role === 'advisor' || a.actsAsAdvisor))
      .map((a) => a.name);
    advisorsCache.set([...new Set(advisors)]);
    res.json({ success: true, advisors: advisorsCache.data });
  } catch (err) {
    console.error('advisors list error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/advisors/me { enabled } — a superadmin adds or removes
// themselves as an advisor. Students already assigned keep their advisor.
router.put('/me', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Say whether to turn it on or off' });
    }
    const me = await findById(req.admin.id);
    if (!me) return res.status(404).json({ success: false, error: 'Account not found' });
    const updated = await setActsAsAdvisor(me.id, req.body.enabled);
    advisorsCache.clear();
    logAudit({
      actor: me.name, role: me.role, action: req.body.enabled ? 'admin.advisor_on' : 'admin.advisor_off', target: me.name,
    });
    res.json({ success: true, actsAsAdvisor: updated.actsAsAdvisor });
  } catch (err) {
    console.error('advisor opt-in error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
