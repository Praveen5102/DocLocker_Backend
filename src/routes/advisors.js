const express = require('express');
const { verifyJWT, requireStaff } = require('../middleware/auth');
const { advisorsCache } = require('../services/cache');
const { listAccounts } = require('../services/accounts');
const { scopeOrgIds } = require('../services/tenantScope');

const router = express.Router();

// GET /api/advisors — the active staff of the caller's own company (a
// superadmin: every company), for the dashboard's advisor pickers.
// Signed-in only: students no longer choose an advisor, so staff names
// aren't exposed publicly at all.
router.get('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    if (advisorsCache.isValid()) {
      return res.json({ success: true, advisors: advisorsCache.data });
    }
    const staff = await listAccounts({ orgIds: await scopeOrgIds(), roles: ['advisor'] });
    const advisors = staff.filter((a) => a.status === 'active').map((a) => a.name);
    advisorsCache.set(advisors);
    res.json({ success: true, advisors });
  } catch (err) {
    console.error('advisors list error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
