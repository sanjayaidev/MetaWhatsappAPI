const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { initDB } = require('./db/schema');
const { requireAuth } = require('./lib/auth');
const { startScheduler } = require('./scheduler');
const webhooksRouter = require('./routes/webhooks');
const connectionsRouter = require('./routes/connections');
const postsRouter = require('./routes/posts');
const automationsRouter = require('./routes/automations');
const commentsRouter = require('./routes/comments');
const authRouter = require('./routes/auth');
const mediaRouter = require('./routes/media');
const insightsRouter = require('./routes/insights');
const aiRouter = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// CORS with credentials support for session cookies
app.use(cors({
  origin: true,
  credentials: true
}));

// Session middleware for persistence
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Webhook routes need the RAW body for signature verification, so they're
// mounted before express.json() and parse their own body internally.
app.use('/', webhooksRouter(pool));

app.use(express.json());
app.use(express.static(__dirname));

// --- Auth routes (public) ---
app.use('/api/auth', authRouter(pool));

// --- Connections OAuth (public: Meta/Google redirect users here directly,
// so it can't sit behind requireAuth — see routes/connections.js) ---
app.use('/api/connections', connectionsRouter.oauthRouter(pool));

// --- Media: public stream proxy (Meta/LinkedIn fetch media here — signed
// URL, not session/JWT guarded, see routes/media.js) ---
app.use('/api/media', mediaRouter.streamRouter(pool));

// --- Protected API routes ---
app.use('/api/connections', requireAuth, connectionsRouter(pool));
app.use('/api/posts', requireAuth, postsRouter(pool));
app.use('/api/automations', requireAuth, automationsRouter(pool));
app.use('/api/comments', requireAuth, commentsRouter(pool));
app.use('/api/media', requireAuth, mediaRouter.router(pool));
app.use('/api/insights', requireAuth, insightsRouter(pool));
app.use('/api/ai', aiRouter(pool));

// --- Static pages (unchanged) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/insights', (req, res) => res.sendFile(path.join(__dirname, 'insights.html')));
app.get('/insights.html', (req, res) => res.sendFile(path.join(__dirname, 'insights.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/privacy-policy', (req, res) => res.sendFile(path.join(__dirname, 'privacy-policy.html')));
app.get('/data-deletion', (req, res) => res.sendFile(path.join(__dirname, 'data-deletion.html')));

async function startServer() {
  await initDB(pool);
  startScheduler(pool);

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(process.env.DATABASE_URL ? '✅ Connected to PostgreSQL' : '⚠️  DATABASE_URL not set');
  });
}

startServer();