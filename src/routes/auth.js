const express = require('express');
const jwt = require('jsonwebtoken');
const { sha256, readAdminsFile, writeAdminsFile } = require('../services/admins');

const router = express.Router();

function signToken(admin) {
  return jwt.sign(
    { name: admin.name, role: admin.role, advisorName: admin.role === 'advisor' ? admin.name : '' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ success: false, error: 'Missing name or password' });

    const data = await readAdminsFile();
    if (!data || !data.admins || data.admins.length === 0) {
      return res.json({ success: false, notInitialized: true });
    }

    const hash = sha256(password);
    const admin = data.admins.find(
      (a) => a.name.toLowerCase() === name.toLowerCase() && a.passwordHash === hash
    );
    if (!admin) return res.json({ success: false, error: 'Invalid name or password' });

    res.json({
      success: true,
      role: admin.role,
      advisorName: admin.role === 'advisor' ? admin.name : '',
      name: admin.name,
      token: signToken(admin),
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/init  — first-time bootstrap
router.post('/init', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ success: false, error: 'Missing name or password' });

    const existing = await readAdminsFile();
    if (existing && existing.admins && existing.admins.length > 0) {
      return res.json({ success: false, error: 'System already initialized. Please login.' });
    }

    const admin = { name, role: 'superadmin', passwordHash: sha256(password), createdAt: new Date().toISOString() };
    await writeAdminsFile({ admins: [admin] });

    res.json({ success: true, role: 'superadmin', advisorName: '', name, token: signToken(admin) });
  } catch (err) {
    console.error('Init error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
