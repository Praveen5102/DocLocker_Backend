require('dotenv').config();

// ── Startup env validation ────────────────────────────────────────────────────
const REQUIRED_ENV = [
  'JWT_SECRET',
  'ROOT_FOLDER_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  const msg = `Missing required environment variables: ${missing.join(', ')}`;
  console.error(`[startup] ${msg}`);
  // In serverless (Vercel) process.exit would crash the function with no response;
  // throw instead so the error surfaces in logs and requests get a 500 with CORS headers.
  if (require.main === module) process.exit(1);
  else throw new Error(msg);
}

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');

const authRoutes        = require('./routes/auth');
const adminsRoutes      = require('./routes/admins');
const advisorsRoutes    = require('./routes/advisors');
const studentsRoutes    = require('./routes/students');
const filesRoutes       = require('./routes/files');
const bankerAccessRoutes = require('./routes/bankerAccess');
const fileProxyRoutes   = require('./routes/fileProxy');
const recoveryRoutes    = require('./routes/recovery');
const auditRoutes       = require('./routes/audit');
const documentReaderRoutes = require('./routes/documentReader');
const { initRailwayStorage } = require('./db/startup');
const studentExtractRoutes = require('./routes/studentExtract');

const app  = express();
const isProd = process.env.NODE_ENV === 'production';

// Railway (and most PaaS hosts) sit behind a single reverse proxy hop, which
// sets X-Forwarded-For. Without trust proxy, express-rate-limit refuses to use
// that header (correctly, to prevent IP spoofing) and logs a warning on every
// request. Trusting exactly 1 hop tells Express to read the real client IP
// from the proxy while still rejecting spoofed X-Forwarded-For chains beyond it.
app.set('trust proxy', 1);

// ── Gzip compression (cuts JSON response size ~70%) ───────────────────────────
app.use(compression({ level: 6, threshold: 1024 }));

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',').map((o) => o.trim());

app.use(cors({
  origin(origin, cb) {
    // Server-to-server (no origin header) — always allow
    if (!origin) return cb(null, true);
    // Wildcard — allow everything
    if (allowedOrigins.includes('*')) return cb(null, true);
    // Exact match from CORS_ORIGIN list
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Allow localhost on any port for local dev (http and https)
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Strict limit on auth endpoints to deter brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// Loose limit on file upload (large payloads, legitimate users do many uploads)
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Upload rate limit exceeded, please slow down.' },
});

// General API limit
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// Tight limit on student lookup — prevents enumeration of valid identifiers
const findLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many lookup requests, please try again later.' },
});

// The document reader proxies to a third-party service that spends real
// compute (3-15s) per call — a much lower ceiling than the general API
// limit so one admin can't accidentally hammer that upstream service.
const documentReaderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many document scans, please wait a few minutes and try again.' },
});

// Student-side reads: a full application is passport + Aadhaar + PAN + 12th
// for the student plus Aadhaar/PAN per co-applicant (up to 5), and a
// two-page document is re-read when its second page arrives.
const studentExtractLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many documents read in a short time, please wait a few minutes and try again.' },
});

app.use('/api/auth',              authLimiter);
app.use('/api/upload',            uploadLimiter);
app.use('/api/student-upload',    uploadLimiter);
app.use('/api/student-meta',      apiLimiter);
app.use('/api/students/find',     findLimiter);
app.use('/api/document-reader',   documentReaderLimiter);
app.use('/api/student-extract',   studentExtractLimiter);
app.use('/api',                   apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/admins',   adminsRoutes);
app.use('/api/advisors', advisorsRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/students', bankerAccessRoutes);
app.use('/api/students', recoveryRoutes);
app.use('/api/files',    fileProxyRoutes);
app.use('/api/audit',    auditRoutes);
app.use('/api/document-reader', documentReaderRoutes);
app.use('/api/student-extract', studentExtractRoutes);
app.use('/api',          filesRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
// In production, never leak internal error details to the client
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  const message = isProd ? 'Internal server error' : err.message;
  res.status(err.status || 500).json({ success: false, error: message });
});

// ── Railway storage (Postgres + encrypted bucket) ─────────────────────────────
// Dormant until DATABASE_URL is set. A failure here must never take the API
// down — Drive-backed features keep working and the error is logged loudly.
initRailwayStorage({ schedule: require.main === module }).catch((err) => {
  console.error('[storage] Railway storage failed to initialise — using Google Drive:', err.message);
});

// ── Start (skipped when imported by Vercel serverless) ────────────────────────
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3001;
  app.listen(PORT, () => {
    console.log(`DocLocker API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
}

module.exports = app;
