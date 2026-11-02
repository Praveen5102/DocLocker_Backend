const express = require('express');
const { verifyJWT, requireStaff } = require('../middleware/auth');
const { canSeeStudent } = require('../services/access');
const { resolveStudent } = require('../services/studentStore');
const { sanitize } = require('../services/drive');
const mail = require('../services/documentEmail');

const router = express.Router();

// GET /api/email/settings → { configured, from, presets }
// The preset addresses are Flyurdream's own mailboxes, so only Flyurdream's
// team is offered them; a partner company types its own.
router.get('/email/settings', verifyJWT, requireStaff, (req, res) => {
  res.json({
    success: true,
    configured: mail.isConfigured(),
    from: process.env.SMTP_USER || '',
    presets: req.admin.company?.kind === 'owner' ? mail.presets() : [],
  });
});

// POST /api/students/:studentKey/email-documents
// Body: { recipients: [email], files: [{ id, label }], note? }
// Staff who can see the student (advisors: their own students). Returns a
// job at once; the email goes out in the background.
router.post('/students/:studentKey/email-documents', verifyJWT, requireStaff, async (req, res) => {
  try {
    const ref = await resolveStudent(sanitize(req.params.studentKey));
    if (!ref || !(await canSeeStudent(req.admin, ref))) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }
    const job = await mail.queueEmail({
      admin: req.admin, ref, recipients: req.body?.recipients, files: req.body?.files, note: req.body?.note,
    });
    res.status(202).json({ success: true, job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    console.error('email documents error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/email/jobs/:id — how a send is going (the sender, or an admin
// of the same company)
router.get('/email/jobs/:id', verifyJWT, requireStaff, (req, res) => {
  const job = mail.getJob(req.params.id, req.admin);
  if (!job) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, job });
});

module.exports = router;
