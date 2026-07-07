const express = require('express');
const jwt = require('jsonwebtoken');
const { hashPassword, verifyPassword, readAdminsFile, writeAdminsFile } = require('../services/admins');

const router = express.Router();

function signToken(admin) {
  return jwt.sign(
    {
      name: admin.name,
      role: admin.role,
      advisorName: admin.role === 'advisor' ? admin.name : '',
      bank: admin.role === 'banker' ? (admin.bank || '') : '',
    },
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

    const admin = data.admins.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!admin) return res.status(401).json({ success: false, error: 'Invalid credentials' });

    const { valid, needsUpgrade } = await verifyPassword(password, admin.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid credentials' });

    // Transparently upgrade legacy SHA-256 hash to bcrypt on successful login
    if (needsUpgrade) {
      admin.passwordHash = await hashPassword(password);
      await writeAdminsFile(data);
    }

    res.json({
      success: true,
      role: admin.role,
      advisorName: admin.role === 'advisor' ? admin.name : '',
      name: admin.name,
      bank: admin.role === 'banker' ? (admin.bank || '') : '',
      token: signToken(admin),
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
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

    const admin = { name, role: 'superadmin', passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    await writeAdminsFile({ admins: [admin] });

    res.json({ success: true, role: 'superadmin', advisorName: '', name, token: signToken(admin) });
  } catch (err) {
    console.error('Init error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
