const express = require('express');
const { sha256, readAdminsFile, writeAdminsFile } = require('../services/admins');
const { verifyJWT, requireSuperAdmin, requireStaff } = require('../middleware/auth');
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

// GET /api/admins/bankers — name + createdAt only, for any staff member
// (superadmin or advisor) managing banker accounts or assigning student
// access. Deliberately narrower than the full /api/admins list so advisors
// aren't exposed to other admins'/advisors' account info.
router.get('/bankers', verifyJWT, requireStaff, async (req, res) => {
  try {
    const data = await readAdminsFile();
    const bankers = (data?.admins || [])
      .filter((a) => a.role === 'banker')
      .map(({ name, createdAt }) => ({ name, createdAt }));
    res.json({ success: true, bankers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Advisors may only manage banker accounts — not other advisors or
// superadmins. Superadmins can manage anyone.
function canManageTarget(requester, targetRole) {
  if (requester.role === 'superadmin') return true;
  if (requester.role === 'advisor') return targetRole === 'banker';
  return false;
}

// POST /api/admins — create new admin. Superadmin can create any role;
// advisors can only create banker accounts.
router.post('/', verifyJWT, requireStaff, async (req, res) => {
  try {
    const { name, role, password } = req.body;
    if (!name || !role || !password) {
      return res.status(400).json({ success: false, error: 'Missing name, role, or password' });
    }
    if (!canManageTarget(req.admin, role)) {
      return res.status(403).json({ success: false, error: 'Advisors can only create banker accounts' });
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

// DELETE /api/admins/:name — delete admin. Superadmin can delete anyone;
// advisors can only delete banker accounts.
router.delete('/:name', verifyJWT, requireStaff, async (req, res) => {
  try {
    const targetName = req.params.name;
    if (targetName === req.admin.name) {
      return res.json({ success: false, error: 'Cannot delete your own account' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    const target = data.admins.find((a) => a.name === targetName);
    if (!target) return res.json({ success: false, error: 'Admin not found' });
    if (!canManageTarget(req.admin, target.role)) {
      return res.status(403).json({ success: false, error: 'Advisors can only remove banker accounts' });
    }

    data.admins = data.admins.filter((a) => a.name !== targetName);
    await writeAdminsFile(data);
    advisorsCache.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admins/:name/reset-password — admin-initiated reset, no current
// password required. Superadmin can reset anyone; advisors can only reset
// banker passwords.
router.put('/:name/reset-password', verifyJWT, requireStaff, async (req, res) => {
  try {
    const targetName = req.params.name;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    const target = data.admins.find((a) => a.name === targetName);
    if (!target) return res.json({ success: false, error: 'Admin not found' });
    if (!canManageTarget(req.admin, target.role)) {
      return res.status(403).json({ success: false, error: 'Advisors can only reset banker passwords' });
    }

    target.passwordHash = sha256(newPassword);
    await writeAdminsFile(data);
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
