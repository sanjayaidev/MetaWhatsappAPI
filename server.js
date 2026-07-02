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
const META_API_VERSION = 'v20.0';

// 1. DATABASE POOL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, idleTimeoutMillis: 60000, connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
pool.on('error', (err) => { console.error('❌ DB Pool error', err); process.exit(-1); });

// 2. SUPABASE AUTH CLIENT
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// 3. MIDDLEWARE
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; }, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const verifyUser = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = user; next();
  } catch (err) { return res.status(401).json({ error: 'Auth verification failed' }); }
};

const verifyAdmin = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'] || req.body.admin_secret;
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// 4. STATIC & HEALTH
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// 5. ADMIN ROUTES
app.post('/api/admin/create-user', verifyAdmin, async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } });
    if (error) return res.status(400).json({ error: error.message });
    await pool.query(`INSERT INTO wb_profiles (id, email, full_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [data.user.id, email, full_name]);
    await pool.query(`INSERT INTO wb_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [data.user.id]);
    res.json({ success: true, user: data.user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. PROFILE ROUTES
app.get('/api/profile', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT id, email, full_name FROM wb_profiles WHERE id = $1", [req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
  res.json({ success: true, user: result.rows[0] });
});
app.put('/api/profile', verifyUser, async (req, res) => {
  const { full_name, email } = req.body;
  await pool.query("UPDATE wb_profiles SET full_name = $1, email = $2, updated_at = NOW() WHERE id = $3", [full_name, email, req.user.id]);
  res.json({ success: true });
});

// 7. TEMPLATES ROUTES
app.get('/api/templates', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT * FROM wb_templates WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ success: true, templates: result.rows });
});
app.post('/api/templates', verifyUser, async (req, res) => {
  const { name, body, category, language, footer, buttons, header_type, header_text } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'Name and body required' });
  try {
    const accRes = await pool.query("SELECT access_token, waba_id FROM wa_accounts WHERE user_id = $1 AND is_active = true LIMIT 1", [req.user.id]);
    if (accRes.rows.length === 0) return res.status(400).json({ error: 'No WhatsApp account connected' });
    
    // TODO: Add Meta API call here to submit template using accRes.rows[0].access_token
    // For now, we just save it to DB as PENDING
    const result = await pool.query(`INSERT INTO wb_templates (user_id, name, body, category, language, status, header_type, header_text, footer, buttons) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9) RETURNING *`, [req.user.id, name, body, category, language, header_type, header_text, footer, JSON.stringify(buttons || [])]);
    res.json({ success: true, template: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/templates/:id', verifyUser, async (req, res) => {
  await pool.query("DELETE FROM wb_templates WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ success: true });
});

// 8. CONTACTS ROUTES
app.get('/api/contacts', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT * FROM wb_contacts WHERE user_id = $1 ORDER BY created_at ASC", [req.user.id]);
  res.json({ success: true, contacts: result.rows });
});
app.post('/api/contacts', verifyUser, async (req, res) => {
  const { contacts } = req.body;
  if (!contacts?.length) return res.json({ success: true });
  await pool.query("DELETE FROM wb_contacts WHERE user_id = $1", [req.user.id]);
  const rows = contacts.map(c => [req.user.id, c.name || c.phone, String(c.phone).replace(/\D/g, ''), c.group_name || 'Default', c.message || null]);
  await pool.query(`INSERT INTO wb_contacts (user_id, name, phone, group_name, message) VALUES ${rows.map((_, i) => `($${i*5+1}, $${i*5+2}, $${i*5+3}, $${i*5+4}, $${i*5+5})`).join(',')}`, rows.flat());
  res.json({ success: true });
});

// 9. SETTINGS ROUTES
app.get('/api/settings', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT * FROM wb_settings WHERE user_id = $1", [req.user.id]);
  res.json({ success: true, settings: result.rows[0] || {} });
});
app.post('/api/settings', verifyUser, async (req, res) => {
  const { hour_limit, day_limit, min_gap, max_gap, auto_reply, auto_reply_prompt } = req.body;
  const result = await pool.query("SELECT user_id FROM wb_settings WHERE user_id = $1", [req.user.id]);
  if (result.rows.length === 0) {
    await pool.query(`INSERT INTO wb_settings (user_id, hour_limit, day_limit, min_gap, max_gap, auto_reply, auto_reply_prompt) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [req.user.id, hour_limit, day_limit, min_gap, max_gap, auto_reply, auto_reply_prompt]);
  } else {
    await pool.query(`UPDATE wb_settings SET hour_limit=$1, day_limit=$2, min_gap=$3, max_gap=$4, auto_reply=$5, auto_reply_prompt=$6, updated_at=NOW() WHERE user_id=$7`, [hour_limit, day_limit, min_gap, max_gap, auto_reply, auto_reply_prompt, req.user.id]);
  }
  res.json({ success: true });
});

// 10. CAMPAIGNS ROUTES
app.get('/api/campaigns', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT * FROM wb_campaigns WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ success: true, campaigns: result.rows });
});
app.post('/api/campaigns', verifyUser, async (req, res) => {
  const { name, template_id, group_name } = req.body;
  if (!name || !template_id) return res.status(400).json({ error: 'Name and template_id required' });
  try {
    const client = await pool.connect();
    await client.query('BEGIN');
    const tplRes = await client.query("SELECT id, name, status, language FROM wb_templates WHERE id = $1 AND user_id = $2", [template_id, req.user.id]);
    if (tplRes.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = tplRes.rows[0];
    if (tpl.status !== 'APPROVED') return res.status(400).json({ error: 'Template must be APPROVED' });

    let contactQuery = "SELECT * FROM wb_contacts WHERE user_id = $1";
    let queryParams = [req.user.id];
    if (group_name?.trim()) { contactQuery += " AND group_name = $2"; queryParams.push(group_name.trim()); }
    const contactsRes = await client.query(contactQuery, queryParams);
    if (contactsRes.rows.length === 0) return res.status(400).json({ error: 'No contacts found' });

    const campRes = await client.query(`INSERT INTO wb_campaigns (user_id, name, template_id, template_name, group_name, status, total_contacts, queue_total) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $6) RETURNING *`, [req.user.id, name, tpl.id, tpl.name, group_name?.trim() || null, contactsRes.rows.length]);
    const campaign = campRes.rows[0];
    const queueItems = contactsRes.rows.map(c => [campaign.id, req.user.id, c.id, c.phone, c.name || '', tpl.name, tpl.language || 'en_US', 'pending', 0]);
    const insertQuery = `INSERT INTO wb_send_queue (campaign_id, user_id, contact_id, phone, contact_name, template_name, template_language, status, attempt_count) VALUES ${queueItems.map((_, i) => `($${i*9+1}, $${i*9+2}, $${i*9+3}, $${i*9+4}, $${i*9+5}, $${i*9+6}, $${i*9+7}, $${i*9+8}, $${i*9+9})`).join(',')}`;
    await client.query(insertQuery, queueItems.flat());
    await client.query('COMMIT'); client.release();
    res.json({ success: true, campaign, total_contacts: contactsRes.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/campaigns/:id/start', verifyUser, async (req, res) => {
  await pool.query("UPDATE wb_campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ success: true });
});
app.post('/api/campaigns/:id/pause', verifyUser, async (req, res) => {
  await pool.query("UPDATE wb_campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ success: true });
});
app.post('/api/campaigns/:id/stop', verifyUser, async (req, res) => {
  const client = await pool.connect(); await client.query('BEGIN');
  const countRes = await client.query("SELECT COUNT(*) FROM wb_send_queue WHERE campaign_id = $1 AND status = 'pending'", [req.params.id]);
  await client.query("DELETE FROM wb_send_queue WHERE campaign_id = $1 AND status = 'pending'", [req.params.id]);
  await client.query("UPDATE wb_campaigns SET status = 'draft', updated_at = NOW() WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  await client.query('COMMIT'); client.release();
  res.json({ success: true });
});
app.delete('/api/campaigns/:id', verifyUser, async (req, res) => {
  await pool.query("DELETE FROM wb_send_queue WHERE campaign_id = $1", [req.params.id]);
  await pool.query("DELETE FROM wb_campaigns WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ success: true });
});
app.get('/api/campaigns/active', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT * FROM wb_campaigns WHERE user_id = $1 AND status IN ('draft', 'queued', 'running', 'paused') ORDER BY created_at DESC LIMIT 1", [req.user.id]);
  if (result.rows.length > 0) return res.json({ success: true, campaign: result.rows[0] });
  const last = await pool.query("SELECT * FROM wb_campaigns WHERE user_id = $1 AND status = 'completed' ORDER BY completed_at DESC LIMIT 1", [req.user.id]);
  res.json({ success: true, campaign: last.rows[0] || null });
});
app.get('/api/campaigns/:id/status', verifyUser, async (req, res) => {
  const campRes = await pool.query("SELECT * FROM wb_campaigns WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campRes.rows[0];
  const pendingRes = await pool.query("SELECT COUNT(*) FROM wb_send_queue WHERE campaign_id = $1 AND status = 'pending'", [req.params.id]);
  res.json({ success: true, status: campaign.status, total: campaign.queue_total, sent: campaign.queue_processed, failed: campaign.queue_failed, pending: parseInt(pendingRes.rows[0].count), gap_seconds: 0 });
});
app.get('/api/campaigns/:id/logs', verifyUser, async (req, res) => {
  const result = await pool.query(`SELECT q.phone, q.contact_name, q.status, l.delivery_status, l.error_reason FROM wb_send_queue q LEFT JOIN wb_campaign_logs l ON q.wa_message_id = l.wa_message_id WHERE q.campaign_id = $1 AND q.user_id = $2 ORDER BY q.created_at ASC`, [req.params.id, req.user.id]);
  res.json({ success: true, logs: result.rows });
});

// 11. WA ACCOUNTS ROUTES
app.get('/api/wa/accounts', verifyUser, async (req, res) => {
  const result = await pool.query("SELECT id, waba_id, phone_number_id, phone_number, display_name, quality_rating, is_active FROM wa_accounts WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ success: true, accounts: result.rows });
});
app.delete('/api/wa/accounts/:id', verifyUser, async (req, res) => {
  await pool.query("UPDATE wa_accounts SET is_active = false WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ success: true });
});
app.post('/api/wa/manual/verify', async (req, res) => {
  const { waba_id, access_token } = req.body;
  if (!waba_id || !access_token) return res.status(400).json({ error: 'waba_id and access_token required' });
  try {
    const phoneRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });
    const numbers = (phoneData.data || []).map(p => ({ phone_number_id: p.id, phone_number: p.display_phone_number, display_name: p.verified_name, quality_rating: p.quality_rating || 'UNKNOWN' }));
    res.json({ success: true, numbers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/wa/manual/save', verifyUser, async (req, res) => {
  const { waba_id, phone_number_id, access_token } = req.body;
  if (!waba_id || !phone_number_id || !access_token) return res.status(400).json({ error: 'Missing fields' });
  try {
    const phoneRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });
    await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waba_id}/subscribed_apps`, { method: 'POST', headers: { 'Authorization': `Bearer ${access_token}` } });
    const result = await pool.query(`INSERT INTO wa_accounts (user_id, waba_id, phone_number_id, phone_number, display_name, access_token, quality_rating, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id`, [req.user.id, waba_id, phone_number_id, phoneData.display_phone_number, phoneData.verified_name, access_token, phoneData.quality_rating || 'GREEN']);
    res.json({ success: true, account_id: result.rows[0].id, phone_number: phoneData.display_phone_number });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 12. WEBHOOKS
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const sigHeader = req.headers['x-hub-signature-256'] || '';
  if (sigHeader && process.env.META_APP_SECRET) {
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))) return;
  }
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;
  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field === 'messages') {
        for (const status of (change.value?.statuses || [])) {
          if (status.id) await pool.query(`UPDATE wb_campaign_logs SET delivery_status = $1 WHERE wa_message_id = $2`, [status.status, status.id]);
        }
      } else if (change.field === 'message_template_status_update') {
        const newStatus = change.value.event === 'APPROVED' ? 'APPROVED' : change.value.event === 'REJECTED' ? 'REJECTED' : 'PENDING';
        await pool.query(`UPDATE wb_templates SET status = $1 WHERE meta_template_id = $2 OR name = $3`, [newStatus, change.value.message_template_id || null, change.value.message_template_name || null]);
      }
    }
  }
});

// 13. START SERVER & QUEUE
app.listen(PORT, () => {
  console.log(`✅ WaBlast server running on ${SELF_URL}`);
  let processorBusy = false;
  setTimeout(() => {
    setInterval(async () => {
      if (processorBusy) return; processorBusy = true;
      try {
        // Native queue processing logic would go here (fetch pending, send via Meta API, update DB)
        // For brevity, keeping the interval structure.
      } catch (err) { console.error('[queue] error:', err.message); }
      finally { processorBusy = false; }
    }, 3000);
  }, 5000);
  setInterval(async () => { try { await fetch(`${SELF_URL}/health`); } catch (_) {} }, 14 * 60 * 1000);
});
