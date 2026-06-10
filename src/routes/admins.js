const express = require('express');
const { sha256, readAdminsFile, writeAdminsFile } = require('../services/admins');
const { verifyJWT, requireSuperAdmin } = require('../middleware/auth');
const { advisorsCache } = require('../services/cache');

const router = express.Router();

// GET /api/admins — list all (superadmin only)
router.get('/', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const data = await readAdminsFile();
    if (!data || !data.admins) return res.json({ success: true, admins: [] });
    res.json({
      success: true,
      admins: data.admins.map(({ name, role, createdAt }) => ({ name, role, createdAt })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admins — create new admin (superadmin only)
router.post('/', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const { name, role, password } = req.body;
    if (!name || !role || !password) {
      return res.status(400).json({ success: false, error: 'Missing name, role, or password' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    if (data.admins.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      return res.json({ success: false, error: 'An admin with this name already exists' });
    }
    data.admins.push({ name, role, passwordHash: sha256(password), createdAt: new Date().toISOString() });
    await writeAdminsFile(data);
    advisorsCache.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admins/:name — delete admin (superadmin only)
router.delete('/:name', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const targetName = req.params.name;
    if (targetName === req.admin.name) {
      return res.json({ success: false, error: 'Cannot delete your own account' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    const before = data.admins.length;
    data.admins = data.admins.filter((a) => a.name !== targetName);
    if (data.admins.length === before) return res.json({ success: false, error: 'Admin not found' });

    await writeAdminsFile(data);
    advisorsCache.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admins/password — change own password (any logged-in admin)
router.put('/password', verifyJWT, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Missing currentPassword or newPassword' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    const currentHash = sha256(currentPassword);
    const admin = data.admins.find((a) => a.name === req.admin.name && a.passwordHash === currentHash);
    if (!admin) return res.json({ success: false, error: 'Current password is incorrect' });

    admin.passwordHash = sha256(newPassword);
    await writeAdminsFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
