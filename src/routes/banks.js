const express = require('express');
const { readBanksFile, writeBanksFile } = require('../services/banks');
const { verifyJWT, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/banks — list all (superadmin only)
router.get('/', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const data = await readBanksFile();
    res.json({ success: true, banks: data.banks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/banks — add a bank (superadmin only)
router.post('/', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, error: 'Missing name or email' });

    const data = await readBanksFile();
    if (data.banks.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      return res.json({ success: false, error: 'A bank with this name already exists' });
    }
    data.banks.push({ name, email, createdAt: new Date().toISOString() });
    await writeBanksFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/banks/:name — remove a bank (superadmin only)
router.delete('/:name', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const targetName = req.params.name;
    const data = await readBanksFile();
    const before = data.banks.length;
    data.banks = data.banks.filter((b) => b.name !== targetName);
    if (data.banks.length === before) return res.json({ success: false, error: 'Bank not found' });

    await writeBanksFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
