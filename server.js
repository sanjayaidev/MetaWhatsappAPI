// server.js — WaBlast Core Server (Native Node.js + Supabase Postgres)
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Import our custom modules
const pool = require('./src/db');
const { encryptToken, decryptToken } = require('./src/crypto');
const campaignsRouter = require('./src/routes/campaigns');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const META_API_VERSION = 'v20.0';

// ================================================================
// 1. SUPABASE AUTH CLIENT (Used ONLY for verifying JWTs & Admin tasks)
// ================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY 
);

// ================================================================
// 2. MIDDLEWARE
// ================================================================
// Parse JSON but keep raw body for Meta Webhook signature verification
app.use(express.json({ 
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '10mb' 
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Middleware 1: Supabase JWT (For Frontend Users) ---
const verifyUser = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = user; 
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

// --- Auth Middleware 3: Admin Secret (For User Registration/Credits) ---
const verifyAdmin = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'] || req.body.admin_secret;
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });
  }
  next();
};

// ================================================================
// 3. STATIC & HEALTH ROUTES
// ================================================================
app.get('/health', (_req, res) => res.json({ status: 'ok', db_pool_size: pool.totalCount }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// ================================================================
// 4. ADMIN ROUTES (Protected by ADMIN_SECRET)
// ================================================================
app.post('/api/admin/create-user', verifyAdmin, async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, 
      user_metadata: { full_name: full_name || email.split('@')[0] }
    });

    if (error) return res.status(400).json({ error: error.message });
    
    // Also create their profile in Postgres
    await pool.query(
      `INSERT INTO wb_profiles (id, email, full_name, credits) VALUES ($1, $2, $3, 50) 
       ON CONFLICT (id) DO NOTHING`,
      [data.user.id, email, full_name || email.split('@')[0]]
    );
    await pool.query(
      `INSERT INTO wb_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [data.user.id]
    );

    res.json({ success: true, user: data.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/grant-credits', verifyAdmin, async (req, res) => {
  const { user_id, amount } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: 'user_id and amount required' });
  
  await pool.query("UPDATE wb_profiles SET credits = credits + $1, updated_at = NOW() WHERE id = $2", [amount, user_id]);
  res.json({ success: true, message: `Granted ${amount} credits` });
});

// ================================================================
// 5. WHATSAPP MANUAL CONNECT (Multiple Numbers Allowed)
// ================================================================
app.post('/api/wa/manual/verify', async (req, res) => {
  const { waba_id, access_token } = req.body;
  if (!waba_id || !access_token) return res.status(400).json({ error: 'waba_id and access_token are required' });

  try {
    const phoneRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
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
      `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });

    // 2. Subscribe to webhooks
    await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    // 3. Encrypt the token before saving to DB
    const encryptedToken = encryptToken(access_token);

    // 4. Save to Supabase Postgres (✅ MULTIPLE NUMBERS: No deactivation of old numbers)
    const insertQuery = `
      INSERT INTO wa_accounts (user_id, waba_id, phone_number_id, phone_number, display_name, access_token, quality_rating, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true)
      RETURNING id;
    `;
    const result = await pool.query(insertQuery, [
      user_id, waba_id, phone_number_id, 
      phoneData.display_phone_number, phoneData.verified_name, 
      encryptedToken, phoneData.quality_rating || 'GREEN'
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

// Get user's WA accounts
app.get('/api/wa/accounts', verifyUser, async (req, res) => {
  const user_id = req.user.id;
  try {
    const result = await pool.query(
      `SELECT id, waba_id, phone_number_id, phone_number, display_name, quality_rating, is_active, created_at 
       FROM wa_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [user_id]
    );
    res.json({ success: true, accounts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 6. EXTERNAL API (For n8n / Zapier)
// ================================================================
app.post('/api/external/send', verifyApiKey, async (req, res) => {
  const { phone_number_id, to, template_name, language_code } = req.body;
  if (!phone_number_id || !to || !template_name) {
    return res.status(400).json({ error: 'phone_number_id, to, and template_name are required' });
  }

  try {
    // Fetch the account details to get the decrypted token
    const accRes = await pool.query(
      'SELECT access_token FROM wa_accounts WHERE phone_number_id = $1 AND user_id = $2 AND is_active = true',
      [phone_number_id, req.user.id]
    );
    if (accRes.rows.length === 0) return res.status(404).json({ error: 'Phone number not found or inactive' });

    const plainToken = decryptToken(accRes.rows[0].access_token);
    
    const payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: template_name,
        language: { code: language_code || 'en_US' }
      }
    };

    const metaRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
      body: JSON.stringify(payload)
    });
    const data = await metaRes.json();
    
    if (metaRes.ok) {
      res.json({ success: true, message_id: data.messages?.[0]?.id });
    } else {
      res.status(metaRes.status).json({ error: data.error?.message || 'Meta API error' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 7. META WEBHOOKS (Native Processing)
// ================================================================
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
  
  const sigHeader = req.headers['x-hub-signature-256'] || '';
  if (sigHeader && process.env.META_APP_SECRET) {
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))) {
      console.warn('[webhook] signature verification FAILED');
      return;
    }
  }

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      const field = change.field;
      const value = change.value;

      if (field === 'messages') {
        // Delivery statuses
        for (const status of (value?.statuses || [])) {
          if (status.id) {
            const updateData = { delivery_status: status.status };
            if (status.status === 'delivered') updateData.delivered_at = new Date().toISOString();
            if (status.status === 'read') updateData.read_at = new Date().toISOString();
            if (status.errors?.[0]?.title) updateData.error_reason = status.errors[0].title;

            await pool.query(
              `UPDATE wb_campaign_logs SET delivery_status = $1, delivered_at = COALESCE($2, delivered_at), read_at = COALESCE($3, read_at), error_reason = $4 WHERE wa_message_id = $5`,
              [status.status, updateData.delivered_at || null, updateData.read_at || null, updateData.error_reason || null, status.id]
            );
          }
        }
      } else if (field === 'message_template_status_update') {
        const newStatus = value.event === 'APPROVED' ? 'APPROVED' : value.event === 'REJECTED' ? 'REJECTED' : 'PENDING';
        await pool.query(
          `UPDATE wb_templates SET status = $1, meta_error = $2, updated_at = NOW() WHERE meta_template_id = $3 OR name = $4`,
          [newStatus, value.reason || null, value.message_template_id || null, value.message_template_name || null]
        );
      }
    }
  }
});

// ================================================================
// 8. MOUNT CAMPAIGNS ROUTER
// ================================================================
app.use('/api/campaigns', verifyUser, campaignsRouter);

// ================================================================
// 9. START SERVER & BACKGROUND JOBS
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ WaBlast server running on ${SELF_URL}`);
  
  // 1. Native Queue Processor (Runs in-memory every 3 seconds)
  let processorBusy = false;
  setTimeout(() => {
    setInterval(async () => {
      if (processorBusy) return;
      processorBusy = true;
      try {
        // processQueue is exported from campaigns.js
        const data = await campaignsRouter.processQueue(); 
        if (data?.processed > 0) {
          console.log('[queue] processed:', { sent: data.sent, failed: data.failed, phone: data.phone });
        }
      } catch (err) {
        console.error('[queue] processor error:', err.message);
      } finally {
        processorBusy = false;
      }
    }, 3000); // Process every 3 seconds
  }, 5000);

  // 2. Health check ping (every 14 min to keep Render awake)
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`);
      console.log('[health] ping sent');
    } catch (_) {}
  }, 14 * 60 * 1000);
});
