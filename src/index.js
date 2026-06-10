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

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const adminsRoutes   = require('./routes/admins');
const advisorsRoutes = require('./routes/advisors');
const studentsRoutes = require('./routes/students');
const filesRoutes    = require('./routes/files');

const app  = express();
const isProd = process.env.NODE_ENV === 'production';

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',').map((o) => o.trim());

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return cb(null, true);
    }
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

app.use('/api/auth',     authLimiter);
app.use('/api/upload',   uploadLimiter);
app.use('/api',          apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/admins',   adminsRoutes);
app.use('/api/advisors', advisorsRoutes);
app.use('/api/students', studentsRoutes);
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

// ── Start (skipped when imported by Vercel serverless) ────────────────────────
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3001;
  app.listen(PORT, () => {
    console.log(`DocLocker API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
}

module.exports = app;
