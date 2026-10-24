const express = require('express');
const { readAuditLog } = require('../services/auditLog');
const { verifyJWT, requireCompanyAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit — superadmin (every company, or one via the company
// header) and company admins (their own company only). Newest first, optionally filtered by
// action / actor, capped to a page size so the client never has to render
// (or wait on) the full multi-thousand-entry history at once.
router.get('/', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    const { action, actor, limit } = req.query;
    let entries = await readAuditLog();
    entries = entries.slice().reverse(); // newest first

    if (action) entries = entries.filter((e) => e.action === action);
    if (actor) entries = entries.filter((e) => e.actor.toLowerCase() === String(actor).toLowerCase());

    const cap = Math.min(Number(limit) || 200, 500);
    res.json({ success: true, entries: entries.slice(0, cap), total: entries.length });
  } catch (err) {
    console.error('audit list error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
