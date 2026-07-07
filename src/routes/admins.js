const express = require('express');
const { hashPassword, verifyPassword, readAdminsFile, writeAdminsFile } = require('../services/admins');
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
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/admins/bankers — name + bank + email + createdAt only, for any staff member
// (superadmin or advisor) managing banker accounts or assigning student
// access. Deliberately narrower than the full /api/admins list so advisors
// aren't exposed to other admins'/advisors' account info.
router.get('/bankers', verifyJWT, requireStaff, async (req, res) => {
  try {
    const data = await readAdminsFile();
    const bankers = (data?.admins || [])
      .filter((a) => a.role === 'banker')
      .map(({ name, createdAt, bank, email }) => ({ name, createdAt, bank: bank || '', email: email || '' }));
    res.json({ success: true, bankers });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
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
    const { name, role, password, bank, email } = req.body;
    if (!name || !role || !password) {
      return res.status(400).json({ success: false, error: 'Missing name, role, or password' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    if (!canManageTarget(req.admin, role)) {
      return res.status(403).json({ success: false, error: 'Advisors can only create banker accounts' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    if (data.admins.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      return res.json({ success: false, error: 'An admin with this name already exists' });
    }
    const record = { name, role, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    if (role === 'banker') { record.bank = bank || ''; record.email = email || ''; }
    data.admins.push(record);
    await writeAdminsFile(data);
    advisorsCache.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
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
    res.status(500).json({ success: false, error: 'Internal server error' });
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

    target.passwordHash = await hashPassword(newPassword);
    await writeAdminsFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/admins/password — change own password (any logged-in admin)
// Must come BEFORE /:name so the literal "password" isn't captured as a param.
router.put('/password', verifyJWT, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Missing currentPassword or newPassword' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
    }
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    const admin = data.admins.find((a) => a.name === req.admin.name);
    if (!admin) return res.status(404).json({ success: false, error: 'Account not found' });

    const { valid } = await verifyPassword(currentPassword, admin.passwordHash);
    if (!valid) return res.json({ success: false, error: 'Current password is incorrect' });

    admin.passwordHash = await hashPassword(newPassword);
    await writeAdminsFile(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/admins/:name — update banker bank/email fields.
router.put('/:name', verifyJWT, requireStaff, async (req, res) => {
  try {
    const targetName = req.params.name;
    const { bank, email } = req.body;
    const data = await readAdminsFile();
    if (!data) return res.status(500).json({ success: false, error: 'System not initialized' });

    const target = data.admins.find((a) => a.name === targetName);
    if (!target) return res.json({ success: false, error: 'Admin not found' });
    if (!canManageTarget(req.admin, target.role)) {
      return res.status(403).json({ success: false, error: 'Not authorized to update this account' });
    }
    if (bank !== undefined) target.bank = bank;
    if (email !== undefined) target.email = email;
    await writeAdminsFile(data);
    advisorsCache.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
