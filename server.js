// server.js — WaBlast Core Server
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ================================================================
// 1. DATABASE POOL (Render Postgres)
// ================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Max concurrent connections
  idleTimeoutMillis: 60000, // ✅ 1 MINUTE DURATION: Close idle connections after 60s
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle Postgres client', err);
  process.exit(-1);
});

// ================================================================
// 2. SUPABASE AUTH CLIENT (Used ONLY for verifying JWTs & Admin tasks)
// ================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Service role needed to create users
);

// ================================================================
// 3. MIDDLEWARE
// ================================================================
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Middleware 1: Supabase JWT (For Frontend Users) ---
const verifyUser = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = user; // Attach Supabase user object to request
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }
};

// --- Auth Middleware 2: API Key (For n8n / External Automation) ---
const verifyApiKey = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

  try {
    // Check Render Postgres for a valid API key linked to a user
    const result = await pool.query(
      'SELECT user_id FROM api_keys WHERE key = $1 AND is_active = true',
      [apiKey]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key' });
    
    req.user = { id: result.rows[0].user_id, is_external: true };
    next();
  } catch (err) {
    console.error('[api-key-auth] error:', err.message);
    return res.status(500).json({ error: 'API key verification failed' });
  }
};

// --- Auth Middleware 3: Admin Secret (For User Registration) ---
const verifyAdmin = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'] || req.body.admin_secret;
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });
  }
  next();
};

// ================================================================
// 4. ROUTES
// ================================================================

// --- Health & Static ---
app.get('/health', (_req, res) => res.json({ status: 'ok', db_pool_size: pool.totalCount }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- Admin: Create User (Protected by ADMIN_SECRET env var) ---
// This replaces the public registration page. Only you (the admin) can call this.
app.post('/api/admin/create-user', verifyAdmin, async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    // Use Supabase Admin API to create the user directly in Auth
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm since admin is creating them
      user_metadata: { full_name: full_name || email.split('@')[0] }
    });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, user: data.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WA Manual Connect (Multiple Numbers Allowed) ---
app.post('/api/wa/manual/verify', async (req, res) => {
  const { waba_id, access_token } = req.body;
  if (!waba_id || !access_token) return res.status(400).json({ error: 'waba_id and access_token are required' });

  try {
    const phoneRes = await fetch(
      `https://graph.facebook.com/v20.0/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });

    const numbers = (phoneData.data || []).map(p => ({
      phone_number_id: p.id,
      phone_number: p.display_phone_number,
      display_name: p.verified_name,
      quality_rating: p.quality_rating || 'UNKNOWN',
    }));
    res.json({ success: true, numbers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wa/manual/save', verifyUser, async (req, res) => {
  const user_id = req.user.id;
  const { waba_id, phone_number_id, access_token } = req.body;
  if (!waba_id || !phone_number_id || !access_token) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Fetch phone details from Meta
    const phoneRes = await fetch(
      `https://graph.facebook.com/v20.0/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });

    // 2. Subscribe to webhooks
    await fetch(`https://graph.facebook.com/v20.0/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    // 3. Save to Render Postgres
    // ✅ MULTIPLE NUMBERS: We simply insert. We DO NOT deactivate other numbers.
    const insertQuery = `
      INSERT INTO wa_accounts (user_id, waba_id, phone_number_id, phone_number, display_name, access_token, quality_rating, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true)
      RETURNING id;
    `;
    const result = await pool.query(insertQuery, [
      user_id, waba_id, phone_number_id, 
      phoneData.display_phone_number, phoneData.verified_name, 
      access_token, phoneData.quality_rating || 'GREEN'
    ]);

    res.json({
      success: true,
      account_id: result.rows[0].id,
      phone_number: phoneData.display_phone_number,
      message: 'Number connected successfully. You can connect multiple numbers.'
    });
  } catch (err) {
    console.error('[wa-save] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- External API for n8n / Automation ---
app.post('/api/external/send', verifyApiKey, async (req, res) => {
  const { phone_number_id, to, message } = req.body;
  if (!phone_number_id || !to || !message) {
    return res.status(400).json({ error: 'phone_number_id, to, and message are required' });
  }
  
  // TODO: Implement actual Meta API send logic here using Render DB to fetch the encrypted token
  res.json({ success: true, message: 'Message queued for external API', to, phone_number_id });
});

app.get('/api/external/status', verifyApiKey, async (req, res) => {
  // TODO: Fetch campaign status from Render DB
  res.json({ success: true, status: 'running', user_id: req.user.id });
});

// --- Meta Webhooks ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Send 200 OK immediately to Meta
  
  // TODO: Verify signature and process webhooks using Render Postgres
  console.log('[webhook] received:', req.body?.object);
});

// ================================================================
// 5. START SERVER & PINGER
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ WaBlast server running on ${SELF_URL}`);
  
  // Health check ping (every 14 min to keep Render awake)
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`);
      console.log('[health] ping sent');
    } catch (_) {}
  }, 14 * 60 * 1000);
});
