const express = require('express');
const { readAdminsFile } = require('../services/admins');
const { advisorsCache } = require('../services/cache');

const router = express.Router();

// GET /api/advisors — public, used by Home page dropdown
router.get('/', async (req, res) => {
  try {
    if (advisorsCache.isValid()) {
      return res.json({ success: true, advisors: advisorsCache.data });
    }
    const data = await readAdminsFile();
    const advisors = data?.admins
      ? data.admins.filter((a) => a.role === 'advisor').map((a) => a.name)
      : [];
    advisorsCache.set(advisors);
    res.json({ success: true, advisors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
