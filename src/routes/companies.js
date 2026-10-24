const express = require('express');
const multer = require('multer');
const { verifyJWT, requireSuperAdmin, requireCompanyAdmin } = require('../middleware/auth');
const { logAudit } = require('../services/auditLog');
const { findCompanyBySlug } = require('../services/tenantScope');
const { AccountError } = require('../services/accounts');
const companies = require('../services/companies');

const router = express.Router();
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: companies.MAX_LOGO_BYTES, files: 1 } });

// Superadmin: any company. A company admin: only their own.
function canEditCompany(req, id) {
  return req.admin.role === 'superadmin' || req.admin.orgId === id;
}

function sendError(res, err) {
  if (err instanceof AccountError) return res.status(err.status).json({ success: false, error: err.message });
  console.error('companies route error:', err.message);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}

// GET /api/companies/public/:slug — what a company signup link shows.
// Public: name and branding only.
router.get('/public/:slug', async (req, res) => {
  try {
    const org = await findCompanyBySlug(req.params.slug);
    if (!org || org.status !== 'active') return res.status(404).json({ success: false, error: 'This signup link is not active' });
    res.json({
      success: true,
      company: companies.publicCompany(org),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/companies/public/:slug/logo — the logo image. Public and cached
// (the URL carries a version); embeddable from the web app's own domain.
router.get('/public/:slug/logo', async (req, res) => {
  try {
    const logo = await companies.getLogoBySlug(req.params.slug);
    if (!logo) return res.status(404).end();
    res.set({
      'Content-Type': logo.mime,
      'Content-Length': logo.buffer.length,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(logo.buffer);
  } catch (err) {
    console.error('company logo error:', err.message);
    res.status(500).end();
  }
});

// GET /api/companies — every company with counts (superadmin)
router.get('/', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    res.json({ success: true, companies: await companies.listCompanies() });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/companies/mine — the caller's own company (admins: settings page)
router.get('/mine', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    res.json({ success: true, company: await companies.getCompany(req.admin.orgId) });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/companies { name, slug?, contactEmail?, branding?, admin: { name, email, password } }
router.post('/', verifyJWT, requireSuperAdmin, async (req, res) => {
  try {
    const company = await companies.createCompany(req.body || {}, { createdBy: req.admin.name });
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'company.create', target: company.name, details: { slug: company.slug, admin: req.body?.admin?.email } });
    res.json({ success: true, company });
  } catch (err) {
    sendError(res, err);
  }
});

// PUT /api/companies/:id { name?, contactEmail?, branding?, status? }
// Superadmin: any company. Company admin: their own, but not its status.
router.put('/:id', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    if (req.admin.role !== 'superadmin' && (req.params.id !== req.admin.orgId || req.body?.status !== undefined)) {
      return res.status(403).json({ success: false, error: 'You can only edit your own company’s details' });
    }
    const before = await companies.getCompany(req.params.id);
    const company = await companies.updateCompany(req.params.id, req.body || {});
    logAudit({
      orgId: company.id, actor: req.admin.name, role: req.admin.role,
      action: before && req.body?.status && before.status !== company.status ? `company.${company.status === 'suspended' ? 'suspend' : 'reactivate'}` : 'company.update',
      target: company.name,
    });
    res.json({ success: true, company });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/companies/:id/logo (multipart "logo")
router.post('/:id/logo', verifyJWT, requireCompanyAdmin, (req, res, next) => {
  logoUpload.single('logo')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'The logo must be 1 MB or smaller' });
    if (err) return res.status(400).json({ success: false, error: 'Could not read the upload' });
    next();
  });
}, async (req, res) => {
  try {
    if (!canEditCompany(req, req.params.id)) return res.status(403).json({ success: false, error: 'You can only change your own company’s logo' });
    const company = await companies.setLogo(req.params.id, req.file?.buffer);
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'company.logo_update', target: company.name });
    res.json({ success: true, company });
  } catch (err) {
    sendError(res, err);
  }
});

// DELETE /api/companies/:id/logo
router.delete('/:id/logo', verifyJWT, requireCompanyAdmin, async (req, res) => {
  try {
    if (!canEditCompany(req, req.params.id)) return res.status(403).json({ success: false, error: 'You can only change your own company’s logo' });
    const company = await companies.clearLogo(req.params.id);
    logAudit({ actor: req.admin.name, role: req.admin.role, action: 'company.logo_remove', target: company.name });
    res.json({ success: true, company });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
