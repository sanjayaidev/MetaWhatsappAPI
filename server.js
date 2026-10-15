// server.js — WaBlast Core Server (Supabase REST API — No pg driver)
// This version uses @supabase/supabase-js for ALL database operations
// to avoid IPv6 connection issues on Render

require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');
const { sendNewMessagePush } = require('./src/push');
const aiChatRouter = require('./src/routes/ai-chat');
const { generateReply, DEFAULT_MODEL: DEFAULT_AI_MODEL } = aiChatRouter;
const { encryptToken, decryptToken } = require('./src/crypto');
const apiKeys = require('./src/api-keys');
const { verifyApiKey, requirePermission, requireScopedAccount } = require('./src/middleware/api-auth');
const interactiveTemplates = require('./src/interactive-templates');
const { buildMessagePayload, buildBotBuilderTemplatePayload, WhatsAppValidationError } = require('./src/whatsapp-interactive');

// CRM module route factories — each exports a function that takes a shared
// `deps` object (supabase client, crypto helpers, verifyUser, etc.) so none
// of them duplicate the client setup that already lives in this file.
const leadsRouter = require('./src/routes/leads');
const integrationsRouter = require('./src/routes/integrations');
const fieldMappingsRouter = require('./src/routes/field-mappings');
const automationsRouter = require('./src/routes/automations');
const flowsRouter = require('./src/routes/flows');
const meetingsRouter = require('./src/routes/meetings');
const chatbotRouter = require('./src/routes/chatbot');
const billingRouter = require('./src/routes/billing');
const webhooksInboundRouter = require('./src/routes/webhooks-inbound');
const sheetWatchersRouter = require('./src/routes/sheet-watchers');
const botBuilderRouter = require('./src/routes/bot-builder');
const ecomRouter = require('./src/routes/ecom');
const paymentsWebhookRouter = require('./src/routes/payments-webhook');
const createCartModule = require('./src/ecom/cart');
const createPaymentsModule = require('./src/payments');
const ecomMessages = require('./src/ecom/messages');
const { matchRule } = require('./src/routes/bot-engine');
const createGoogleAuthHelper = require('./src/google-auth');
const { startSheetPoller } = require('./src/sheet-poller');
const { startPaymentPoller } = require('./src/payment-poller');
const createChannelSender = require('./src/channel-send');

// --- Social Manager (sm/) integration ---------------------------------
// sm/ was originally a standalone app (SMClient) using its own raw
// node-postgres Pool. It's mounted here under the /sm namespace and now
// shares this process's Supabase REST client (`supabase`, created below)
// instead of opening a pg connection — the same @supabase/supabase-js
// approach the rest of this app uses, avoiding the pg/IPv6 issues on Render
// that the file banner above describes. Schema for its smc_* tables lives
// in migrations/004_smclient_tables_with_prefix.sql (see sm/db/schema.js).
const session = require('express-session');
const { initDB: initSmcDB } = require('./sm/db/schema');
const { requireAuth: smcRequireAuth } = require('./sm/lib/auth');
const { startScheduler: startSmcScheduler } = require('./sm/scheduler');
const smcWebhooksRouter = require('./sm/routes/webhooks');
const smcConnectionsRouter = require('./sm/routes/connections');
const smcPostsRouter = require('./sm/routes/posts');
const smcAutomationsRouter = require('./sm/routes/automations');
const smcCommentsRouter = require('./sm/routes/comments');
const smcAuthRouter = require('./sm/routes/auth');
const smcMediaRouter = require('./sm/routes/media');
const smcInsightsRouter = require('./sm/routes/insights');
const smcAiRouter = require('./sm/routes/ai');
const smcAdminDriveRouter = require('./sm/routes/admin-drive');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const META_API_VERSION = 'v23.0';

// ================================================================
// 1. SUPABASE CLIENT (REST API — bypasses pg/IPv6 entirely)
// ================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // service_role bypasses RLS
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket }
  }
);

// Ecom cart/checkout — instantiated once here so both the REST routers
// (mounted further down) and handleIncomingMessage's bot flow (below) share
// the exact same cart/order logic instead of two divergent copies.
const ecomCart = createCartModule({ supabase });
const ecomPayments = createPaymentsModule({ supabase });

// Low-level Facebook/Instagram Messenger sender for the ecom bot flow (cart
// taps, catalog carousel, checkout link — see handleEcomInteraction and
// handleIncomingMessengerEvent below). WhatsApp ecom sends still go straight
// through wa_accounts' own phone_number_id + token, same as before — this is
// only used for the two channels that route through a Page access token.
const ecomChannelSender = createChannelSender({ supabase, decryptToken, encryptToken, META_API_VERSION, fetch });

// Shared with bot-engine's matchRule() below, so a bot-builder rule with a
// sheet_lookup configured can fetch a valid Google access token the same way
// src/routes/flows.js's Sheets endpoints already do.
const { getValidGoogleAccessToken } = createGoogleAuthHelper({ supabase, encryptToken, decryptToken, fetch });

// ================================================================
// 2. CRYPTO — AES-256-GCM for WA token encryption
// (moved to ./src/crypto.js — single source of truth, imported above)
// ================================================================

// ================================================================
// 3. MIDDLEWARE
// ================================================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json({ 
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '10mb' 
}));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware — required by sm/'s requireAuth (session OR Bearer JWT,
// see sm/lib/auth.js). Only sm/'s routes read req.session; the rest of the
// app is unaffected.
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Public, safe-to-expose config for browser pages that need to talk to
// Supabase Auth directly (e.g. login.html). Only the URL and the anon
// key are ever exposed here — never the service role key. This replaces
// hardcoding SUPABASE_URL/SUPABASE_ANON_KEY inside login.html, which made
// it easy for the frontend and backend to silently point at two different
// Supabase projects.
app.get('/api/public-config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

// Runs on every request: if an `sk_live_...` API key is present (Authorization
// header or x-api-key), validate it, apply its rate limits, and populate
// req.user/req.apiKey. Otherwise it's a no-op and falls through to verifyUser's
// Supabase JWT check below. Previously this middleware existed but was never
// mounted, so generated API keys couldn't actually authenticate anywhere.
app.use(verifyApiKey);

// Auth middleware — verifies Supabase JWT (works for email + Google + FB).
// Skips straight through if verifyApiKey already authenticated this request.
const verifyUser = async (req, res, next) => {
  if (req.user) return next();
  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) token = String(req.headers['x-api-key'] || '').trim();
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

// Gate for anything under the "API" surface (key management routes, the
// api-keys.html page). This is separate from and on top of per-key
// permissions (can_send_messages, etc.) on wb_api_keys — it's an
// account-level master switch stored on wb_profiles.account_type. A user can
// have a perfectly valid dashboard login (or even a valid sk_live_ key) and
// still be blocked here if their account_type is 'regular' (dashboard-only).
const requireApiAccess = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { data: profile, error } = await supabase
    .from('wb_profiles')
    .select('account_type')
    .eq('id', req.user.id)
    .single();
  if (error) {
    console.error('[requireApiAccess] profile lookup failed', req.user.id, error);
    return res.status(500).json({ error: 'Could not verify API access' });
  }
  if (!['api', 'full'].includes(profile?.account_type)) {
    return res.status(403).json({ error: 'API access is not enabled for this account' });
  }
  next();
};

// Admin middleware — protects user creation endpoint
const verifyAdmin = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'] || req.body?.admin_secret;
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });
  }
  next();
};

// Login-free read-only inbox (revocable ?pass=... link). See migrations/009_public_inbox.sql
app.use(require('./src/routes/public-inbox')({ supabase, verifyAdmin, loadInboundAudio, sendMediaBuffer }));

// ================================================================
// 4. STATIC & HEALTH
// ================================================================
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ================================================================
// 5. ADMIN ROUTES
// ================================================================
app.post('/api/admin/create-user', verifyAdmin, async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: full_name || email.split('@')[0] }
    });
    if (error) return res.status(400).json({ error: error.message });
    
    // Create profile + settings rows via REST
    await supabase.from('wb_profiles').upsert({
      id: data.user.id, email, full_name: full_name || email.split('@')[0],
      credits: 50, free_credits_granted: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    
    await supabase.from('wb_settings').upsert({
      user_id: data.user.id,
      hour_limit: 1000, day_limit: 5000, min_gap: 5, max_gap: 15,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    
    res.json({ success: true, user: data.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 6. PROFILE ROUTES
// ================================================================
// Dedicated login for the API surface — deliberately separate from the
// dashboard's session flow (public/login.html -> /dashboard.html). Same
// underlying Supabase credentials, but this endpoint additionally requires
// wb_profiles.account_type to be 'api' or 'full' before it will hand back a
// usable token. Valid dashboard credentials alone are NOT enough to pass
// this endpoint if the account is 'regular'.
app.post('/api/auth/api-login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    // IMPORTANT: sign in on a throwaway client, never on the shared `supabase`
    // (service-role) instance. Even with persistSession/autoRefreshToken off,
    // a successful signInWithPassword on the shared client updates its
    // in-memory session, which then gets used as the Authorization header for
    // ALL subsequent .from() calls on that same instance — silently turning
    // the "service role" client into a request scoped to whichever user just
    // logged in. That made the profile lookup below run under the user's own
    // (RLS-restricted) session instead of service_role, returning 0 rows
    // (PGRST116) even though the row plainly existed.
    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data?.session) {
      return res.status(401).json({ error: error?.message || 'Invalid credentials' });
    }

    // Untouched service-role `supabase` client — guaranteed to bypass RLS.
    const { data: profile, error: profileErr } = await supabase
      .from('wb_profiles')
      .select('account_type')
      .eq('id', data.user.id)
      .single();

    if (profileErr) {
      console.error('[api-login] profile lookup failed', data.user.id, profileErr);
      return res.status(500).json({ error: 'Could not verify API access' });
    }
    if (!['api', 'full'].includes(profile?.account_type)) {
      // Valid credentials, but this account isn't allowed onto the API surface.
      return res.status(403).json({ error: 'API access is not enabled for this account' });
    }

    res.json({
      success: true,
      token: data.session.access_token,
      user: { id: data.user.id, email: data.user.email }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) token = String(req.headers['x-api-key'] || '').trim();
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    return res.json({ success: true, user: { id: user.id, email: user.email, user_metadata: user.user_metadata } });
  } catch (err) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }
});

// Used by api-keys.html on page load: confirms the token is valid AND the
// account has API access, in one call. verifyUser already ran (via app.use
// or explicit middleware) to populate req.user by the time this runs.
app.get('/api/auth/api-verify', verifyUser, requireApiAccess, (req, res) => {
  res.json({ success: true, user: { id: req.user.id, email: req.user.email } });
});

app.get('/api/profile', verifyUser, async (req, res) => {
  // Try to get existing profile
  let { data, error } = await supabase
    .from('wb_profiles')
    .select('id, email, full_name, account_type')
    .eq('id', req.user.id)
    .single();
  
  // If profile doesn't exist, create it
  if (error || !data) {
    const newProfile = {
      id: req.user.id,
      email: req.user.email || '',
      full_name: req.user.user_metadata?.full_name || req.user.email?.split('@')[0] || 'User',
      credits: 50,
      free_credits_granted: true,
      account_type: 'regular',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Create profile
    await supabase.from('wb_profiles').insert(newProfile);
    
    // Create settings if doesn't exist
    await supabase.from('wb_settings').upsert({
      user_id: req.user.id,
      hour_limit: 1000,
      day_limit: 5000,
      min_gap: 5,
      max_gap: 15,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    
    data = newProfile;
  }
  
  res.json({ success: true, user: data });
});

app.put('/api/profile', verifyUser, async (req, res) => {
  const { full_name, email } = req.body;
  const { error } = await supabase
    .from('wb_profiles')
    .update({ full_name, email, updated_at: new Date().toISOString() })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});
// ============================================================
// Add this block to server.js, near the other /api/wa/* routes
// (e.g. right after app.post('/api/wa/manual/save', ...)).
//
// Also add to your .env / Render environment:
//   INTERNAL_API_SECRET=<a long random string, matching the edge function's secret>
// ============================================================

// Guards the one endpoint the whatsapp-embedded-signup edge function is
// allowed to call. This is intentionally NOT verifyUser — the edge function
// has already authenticated the end user itself (via their Supabase JWT in
// /start) and is acting as a trusted backend, not as that user's browser.
const verifyInternalSecret = (req, res, next) => {
  const provided = req.headers['x-internal-secret'];
  if (!process.env.INTERNAL_API_SECRET || provided !== process.env.INTERNAL_API_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// Final step of the Embedded Signup flow: the edge function has already
// exchanged the code, subscribed webhooks, and registered the number by the
// time this is called. All this does is encrypt the token and persist the
// account — the same shape as /api/wa/manual/save, minus the Meta calls.
app.post('/api/internal/wa/embedded-signup-complete', verifyInternalSecret, async (req, res) => {
  const { user_id, waba_id, phone_number_id, access_token, phone_number, display_name, quality_rating } = req.body || {};
  if (!user_id || !waba_id || !phone_number_id || !access_token || !phone_number) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const encryptedToken = encryptToken(access_token);

    const { data: inserted, error: insertErr } = await supabase
      .from('wa_accounts')
      .insert({
        user_id,
        waba_id,
        phone_number_id,
        phone_number,
        display_name: display_name || phone_number,
        access_token: encryptedToken,
        quality_rating: quality_rating || 'UNKNOWN',
        is_active: true,
        messages_sent_today: 0,
        last_reset_date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[embedded-signup-complete] insert failed', insertErr);
      return res.status(500).json({ error: 'Failed to save account: ' + insertErr.message });
    }

    res.json({ success: true, account_id: inserted.id });
  } catch (err) {
    console.error('[embedded-signup-complete] error', err);
    res.status(500).json({ error: err.message });
  }
});
// ================================================================
// 7. TEMPLATES ROUTES
// ================================================================
app.get('/api/templates', verifyUser, async (req, res) => {
  const { data, error } = await supabase
    .from('wb_templates')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, templates: data || [] });
});

app.post('/api/templates', verifyUser, async (req, res) => {
  const { name, body, category, language, footer, buttons, header_type, header_text, header_media_url, header_media_id, placeholders } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'Name and body required' });
  if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Name must be lowercase letters, numbers, underscores only' });

  try {
    // Get user's WA account for Meta API call
    const { data: accounts } = await supabase
      .from('wa_accounts')
      .select('access_token, waba_id')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (!accounts?.length) return res.status(400).json({ error: 'No WhatsApp account connected' });
    
    const account = accounts[0];
    const plainToken = decryptToken(account.access_token);

    // Build Meta components
    const components = [];
    if (header_type && header_type !== 'NONE') {
      const header = { type: 'HEADER' };
      if (header_type === 'TEXT') {
        header.format = 'TEXT';
        header.text = header_text || '';
      } else {
        header.format = header_type;
        const mediaHandle = header_media_id || header_media_url;
        if (mediaHandle) header.example = { header_handle: [mediaHandle] };
      }
      components.push(header);
    }
    components.push({ type: 'BODY', text: body });
    if (footer?.trim()) components.push({ type: 'FOOTER', text: footer.trim() });
    if (buttons?.length) {
      const buttonComp = { type: 'BUTTONS', buttons: [] };
      for (const btn of buttons) {
        if (btn.type === 'QUICK_REPLY') buttonComp.buttons.push({ type: 'QUICK_REPLY', text: btn.text });
        else if (btn.type === 'URL') buttonComp.buttons.push({ type: 'URL', text: btn.text, url: btn.url });
        else if (btn.type === 'PHONE_NUMBER') buttonComp.buttons.push({ type: 'PHONE_NUMBER', text: btn.text, phone_number: btn.phone });
        else if (btn.type === 'COPY_CODE') buttonComp.buttons.push({ type: 'COPY_CODE', example: [btn.text] });
      }
      if (buttonComp.buttons.length) components.push(buttonComp);
    }

    // Submit to Meta
    const metaRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${account.waba_id}/message_templates`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
        body: JSON.stringify({ name, category: category || 'MARKETING', language: language || 'en_US', components })
      }
    );
    const metaData = await metaRes.json();
    if (!metaRes.ok) return res.status(400).json({ error: metaData.error?.message || 'Meta API error', meta_error: metaData.error });

    // Save to DB
    const { data: inserted, error: insertErr } = await supabase
      .from('wb_templates')
      .insert({
        user_id: req.user.id, name, body,
        category: category || 'MARKETING', language: language || 'en_US',
        status: 'PENDING', header_type: header_type || 'NONE',
        header_text: header_text || null, header_media_url: header_media_url || null,
        footer: footer || null, buttons: buttons || [], placeholders: placeholders || [],
        meta_template_id: metaData.id || null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (insertErr) return res.status(500).json({ error: 'DB save failed: ' + insertErr.message });
    res.json({ success: true, template: inserted, message: 'Template submitted for Meta review.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', verifyUser, async (req, res) => {
  const { data: tpl } = await supabase
    .from('wb_templates')
    .select('name')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  // Try to delete from Meta too
  const { data: accounts } = await supabase
    .from('wa_accounts')
    .select('access_token, waba_id')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .limit(1);
  
  if (accounts?.length) {
    const plainToken = decryptToken(accounts[0].access_token);
    await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${accounts[0].waba_id}/message_templates?name=${encodeURIComponent(tpl.name)}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${plainToken}` } }
    );
  }

  const { error } = await supabase
    .from('wb_templates')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/templates/media/upload', verifyUser, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File upload required' });

  const { data: accounts, error: accountError } = await supabase
    .from('wa_accounts')
    .select('access_token, phone_number_id')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (accountError) return res.status(500).json({ error: accountError.message });
  if (!accounts?.length) return res.status(400).json({ error: 'No WhatsApp account connected' });

  const account = accounts[0];
  const plainToken = decryptToken(account.access_token);
  try {
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    const metaRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${account.phone_number_id}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${plainToken}` },
        body: form
      }
    );
    const data = await metaRes.json();
    if (!metaRes.ok) return res.status(metaRes.status).json({ error: data.error?.message || 'Media upload failed', detail: data });

    res.json({ success: true, media_id: data.id, mime_type: data.mime_type, url: data.url || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates/meta/sync', verifyUser, async (req, res) => {
  const { data: accounts, error: accountError } = await supabase
    .from('wa_accounts')
    .select('access_token, waba_id')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (accountError) return res.status(500).json({ error: accountError.message });
  if (!accounts?.length) return res.status(400).json({ error: 'No WhatsApp account connected' });

  const account = accounts[0];
  const plainToken = decryptToken(account.access_token);

  try {
    const response = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${account.waba_id}/message_templates?fields=id,name,status,language,category,components`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${plainToken}` } }
    );
    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: errorData.error?.message || 'Failed to fetch from Meta' });
    }

    const data = await response.json();
    const allMetaTemplates = data.data || [];
    const approvedTemplates = allMetaTemplates.filter(t => t.status === 'APPROVED');

    const { data: localTemplates, error: localError } = await supabase
      .from('wb_templates')
      .select('id,name,meta_template_id,status')
      .eq('user_id', req.user.id);
    if (localError) return res.status(500).json({ error: localError.message });

    const syncPromises = [];
    for (const tpl of approvedTemplates) {
      const existing = localTemplates?.find(l => l.meta_template_id === tpl.id) || localTemplates?.find(l => l.name === tpl.name);
      const bodyComp = (tpl.components || []).find(c => c.type === 'BODY');
      const footerComp = (tpl.components || []).find(c => c.type === 'FOOTER');
      const headerComp = (tpl.components || []).find(c => c.type === 'HEADER');
      const headerType = headerComp?.format || 'NONE';
      const headerText = headerType === 'TEXT' ? headerComp?.text || null : null;

      if (existing) {
        const updateData = {};
        if (existing.status !== 'APPROVED') updateData.status = 'APPROVED';
        if (!existing.meta_template_id) updateData.meta_template_id = tpl.id;
        if (Object.keys(updateData).length) {
          syncPromises.push(
            supabase.from('wb_templates').update({ ...updateData, updated_at: new Date().toISOString() }).eq('id', existing.id)
          );
        }
      } else {
        syncPromises.push(
          supabase.from('wb_templates').insert({
            user_id: req.user.id,
            name: tpl.name,
            body: bodyComp?.text || '',
            category: tpl.category || 'MARKETING',
            language: tpl.language || 'en_US',
            status: 'APPROVED',
            header_type: headerType,
            header_text: headerText,
            header_media_url: null,
            footer: footerComp?.text || null,
            buttons: [],
            placeholders: [],
            meta_template_id: tpl.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        );
      }
    }

    // Remove local templates that Meta no longer reports as APPROVED for this account
    // (rejected, paused, deleted directly in Meta, or otherwise no longer valid to send).
    const metaApprovedIds = new Set(approvedTemplates.map(t => t.id));
    const metaApprovedNames = new Set(approvedTemplates.map(t => t.name));
    const staleLocal = (localTemplates || []).filter(l => {
      const stillOnMeta = l.meta_template_id
        ? metaApprovedIds.has(l.meta_template_id)
        : metaApprovedNames.has(l.name);
      return l.status === 'APPROVED' && !stillOnMeta;
    });
    if (staleLocal.length) {
      syncPromises.push(
        supabase.from('wb_templates').delete().in('id', staleLocal.map(l => l.id))
      );
    }

    const syncResults = await Promise.all(syncPromises);
    const syncErrors = syncResults.filter(r => r?.error).map(r => r.error);
    if (syncErrors.length) {
      // Supabase query builder promises RESOLVE (not reject) even on failure,
      // so Promise.all alone would never surface these — every failed
      // upsert/delete here would silently report "synced: true" while some
      // templates quietly kept a stale local status.
      console.error('[templates/sync] some sync operations failed:', syncErrors);
    }
    res.json({
      success: true,
      templates: approvedTemplates,
      synced: true,
      sync_errors: syncErrors.length || undefined,
      removed: staleLocal.map(l => l.name)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync approved templates: ' + err.message });
  }
});

app.get('/api/templates/meta/approved', verifyUser, async (req, res) => {
  // Get user's active WA account
  const { data: accounts } = await supabase
    .from('wa_accounts')
    .select('access_token, waba_id, phone_number_id')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  
  if (!accounts?.length) {
    return res.status(400).json({ error: 'No WhatsApp account connected' });
  }

  const account = accounts[0];
  const plainToken = decryptToken(account.access_token);

  try {
    // Fetch approved templates from Meta
    const response = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${account.waba_id}/message_templates?fields=name,status,language,category,components`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${plainToken}` } }
    );
    
    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: errorData.error?.message || 'Failed to fetch from Meta' });
    }

    const data = await response.json();
    const approvedTemplates = (data.data || []).filter(t => t.status === 'APPROVED');

    // Same cleanup as /meta/sync: drop local templates no longer approved on Meta.
    const { data: localTemplates } = await supabase
      .from('wb_templates')
      .select('id,name,meta_template_id,status')
      .eq('user_id', req.user.id)
      .eq('status', 'APPROVED');
    const metaApprovedIds = new Set(approvedTemplates.map(t => t.id));
    const metaApprovedNames = new Set(approvedTemplates.map(t => t.name));
    const staleLocal = (localTemplates || []).filter(l => {
      const stillOnMeta = l.meta_template_id
        ? metaApprovedIds.has(l.meta_template_id)
        : metaApprovedNames.has(l.name);
      return !stillOnMeta;
    });
    if (staleLocal.length) {
      await supabase.from('wb_templates').delete().in('id', staleLocal.map(l => l.id));
    }

    res.json({
      success: true,
      templates: approvedTemplates.map(t => ({
        name: t.name,
        status: t.status,
        language: t.language || 'en_US',
        category: t.category || 'MARKETING',
        components: t.components || []
      })),
      removed: staleLocal.map(l => l.name)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch approved templates: ' + err.message });
  }
});

// ================================================================
// 8. CONTACTS ROUTES
// ================================================================
app.get('/api/contacts', verifyUser, async (req, res) => {
  const { data, error } = await supabase
    .from('wb_contacts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, contacts: data || [] });
});

app.post('/api/contacts', verifyUser, async (req, res) => {
  const { contacts } = req.body;
  if (!contacts?.length) return res.json({ success: true });
  
  // Snapshot existing contacts so a failed insert can't leave the user with an
  // empty list (previously: delete → insert fails → "No contacts found" in campaigns).
  const { data: previousRows } = await supabase.from('wb_contacts').select('*').eq('user_id', req.user.id);
  await supabase.from('wb_contacts').delete().eq('user_id', req.user.id);

  const seenPhones = new Set();
  const rows = contacts.filter(c => {
    const p = String(c.phone || '').replace(/\D/g, '');
    if (!p || seenPhones.has(p)) return false;
    seenPhones.add(p);
    return true;
  }).map(c => ({
    user_id: req.user.id,
    name: c.name || c.phone,
    phone: String(c.phone).replace(/\D/g, ''),
    group_name: c.group_name || 'Default',
    message: c.message || null,
    custom_fields: (c.custom_fields && typeof c.custom_fields === 'object' && Object.keys(c.custom_fields).length)
      ? c.custom_fields
      : null,
    status: 'pending', optin: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));
  
  const { error } = await supabase.from('wb_contacts').insert(rows);
  if (error) {
    console.error('[contacts] insert failed:', { code: error.code, message: error.message, details: error.details, hint: error.hint });
    // Put the old list back so nothing is lost.
    if (previousRows?.length) {
      const { error: restoreErr } = await supabase.from('wb_contacts').insert(previousRows);
      if (restoreErr) console.error('[contacts] could not restore previous contacts:', restoreErr.message);
    }
    const missingCol = /custom_fields/i.test(error.message || '') || error.code === 'PGRST204' || error.code === '42703';
    return res.status(500).json({
      error: missingCol
        ? 'Database is missing the contacts.custom_fields column. Run migrations/010_contacts_custom_fields.sql in Supabase, then save again. (' + error.message + ')'
        : error.message
    });
  }

  // Feed names into the persistent phone->name directory too, but only
  // for numbers that don't already have one saved — a campaign list
  // shouldn't be able to overwrite a name someone already saved from the
  // inbox (e.g. a blank/wrong name column in a sloppy CSV upload).
  // ignoreDuplicates: true means "insert if missing, skip if the
  // (user_id, phone) pair already exists" rather than overwriting.
  try {
    await supabase.from('wb_known_contacts').upsert(
      rows.map(r => ({ user_id: r.user_id, phone: r.phone, name: r.name, updated_at: new Date().toISOString() })),
      { onConflict: 'user_id,phone', ignoreDuplicates: true }
    );
  } catch (e) {
    console.error('[contacts] failed to update known-contacts directory:', e.message);
  }

  // Return saved contacts
  const { data } = await supabase
    .from('wb_contacts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });
  
  res.json({ success: true, contacts: data || [] });
});

// Persistent phone->name directory, used for Inbox sender display and
// never touched by the campaign upload/delete cycle above. This one DOES
// overwrite on conflict — unlike the campaign-upload feed-in, this is a
// deliberate, explicit action from the person using the app, so it should
// win over whatever a stale campaign list previously guessed at.
app.post('/api/known-contacts', verifyUser, async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone || !name?.trim()) return res.status(400).json({ error: 'phone and name are required' });

  const { error } = await supabase.from('wb_known_contacts').upsert(
    {
      user_id: req.user.id,
      phone: String(phone).replace(/\D/g, ''),
      name: name.trim(),
      updated_at: new Date().toISOString()
    },
    { onConflict: 'user_id,phone' }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ================================================================
// 9. SETTINGS ROUTES
// ================================================================
app.get('/api/settings', verifyUser, async (req, res) => {
  const { data } = await supabase
    .from('wb_settings')
    .select('*')
    .eq('user_id', req.user.id)
    .single();
  res.json({ success: true, settings: data || {} });
});

app.post('/api/settings', verifyUser, async (req, res) => {
  const update = { updated_at: new Date().toISOString() };
  if (req.body.hour_limit !== undefined) update.hour_limit = parseInt(req.body.hour_limit) || 0;
  if (req.body.day_limit !== undefined) update.day_limit = parseInt(req.body.day_limit) || 0;
  if (req.body.min_gap !== undefined) update.min_gap = parseInt(req.body.min_gap) || 5;
  if (req.body.max_gap !== undefined) update.max_gap = parseInt(req.body.max_gap) || 15;
  if (req.body.auto_reply !== undefined) update.auto_reply = req.body.auto_reply;
  if (req.body.auto_reply_prompt !== undefined) update.auto_reply_prompt = req.body.auto_reply_prompt;
  if (req.body.auto_reply_model !== undefined) update.auto_reply_model = req.body.auto_reply_model;
  if (req.body.auto_reply_mode !== undefined) update.auto_reply_mode = req.body.auto_reply_mode;
  if (req.body.auto_reply_template_id !== undefined) update.auto_reply_template_id = req.body.auto_reply_template_id || null;

  const { error } = await supabase
    .from('wb_settings')
    .upsert({ user_id: req.user.id, ...update }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ================================================================
// 10. CAMPAIGNS ROUTES
// ================================================================
app.get('/api/campaigns', verifyUser, async (req, res) => {
  const { data, error } = await supabase
    .from('wb_campaigns')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, campaigns: data || [] });
});

app.post('/api/campaigns', verifyUser, requirePermission('canManageCampaigns'), async (req, res) => {
  const { name, template_id, group_name, schedule_at, start_now, placeholder_mapping } = req.body;
  if (!name) return res.status(400).json({ error: 'Campaign name required' });
  if (!template_id) return res.status(400).json({ error: 'template_id required' });

  const scheduledAt = schedule_at ? new Date(schedule_at) : null;
  if (schedule_at && (!scheduledAt || isNaN(scheduledAt.getTime()))) {
    return res.status(400).json({ error: 'Invalid schedule date' });
  }
  if (schedule_at && scheduledAt <= new Date()) {
    return res.status(400).json({ error: 'Scheduled date must be in the future' });
  }
  const isScheduled = scheduledAt && scheduledAt > new Date();
  let status = isScheduled ? 'scheduled' : (start_now ? 'running' : 'draft');

  if (!isScheduled && start_now) {
    const { data: activeCampaign } = await supabase
      .from('wb_campaigns')
      .select('id, name, status')
      .eq('user_id', req.user.id)
      .in('status', ['queued', 'running', 'paused'])
      .limit(1)
      .single();
    if (activeCampaign) {
      return res.status(400).json({ 
        error: `Campaign "${activeCampaign.name}" is already ${activeCampaign.status}. Stop it first.`,
        active_campaign: activeCampaign 
      });
    }
  }

  // Get template
  const { data: tpl, error: tplErr } = await supabase
    .from('wb_templates')
    .select('id, name, status, language')
    .eq('id', template_id)
    .eq('user_id', req.user.id)
    .single();
  if (tplErr || !tpl) return res.status(404).json({ error: 'Template not found' });
  if (tpl.status !== 'APPROVED') return res.status(400).json({ error: 'Template must be APPROVED' });

  // Get contacts
  let contactsQuery = supabase.from('wb_contacts').select('*').eq('user_id', req.user.id);
  if (group_name?.trim()) contactsQuery = contactsQuery.eq('group_name', group_name.trim());
  const { data: contacts } = await contactsQuery;
  if (!contacts?.length) return res.status(400).json({ error: 'No contacts found' });

  // Parse and store placeholder mapping if present.
  // Supports any number of placeholders: numeric keys ("1","2",...) for
  // positional {{1}} {{2}} templates, or string keys ("a","b",...) for named
  // {{a}} {{b}} templates. Validated here so bad input fails fast with a clear
  // message instead of surfacing later as a cryptic Meta API error mid-send.
  if (placeholder_mapping !== undefined) {
    if (typeof placeholder_mapping !== 'object' || placeholder_mapping === null || Array.isArray(placeholder_mapping)) {
      return res.status(400).json({ error: 'placeholder_mapping must be a JSON object' });
    }
    const entries = Object.entries(placeholder_mapping);
    if (entries.length) {
      const keyStyles = new Set(entries.map(([key]) => (/^\d+$/.test(key) ? 'positional' : 'named')));
      if (keyStyles.size > 1) {
        return res.status(400).json({ error: 'placeholder_mapping keys must be all numeric ("1","2",...) or all named ("a","b",...), not mixed' });
      }
      const validTypes = new Set(['phone', 'name', 'message', 'field', 'custom']);
      for (const [key, map] of entries) {
        if (typeof map !== 'object' || map === null || !validTypes.has(map.type)) {
          return res.status(400).json({ error: `placeholder_mapping["${key}"] must have a type of "phone", "name", "message", "field", or "custom"` });
        }
        if (map.type === 'custom' && typeof map.value !== 'string') {
          return res.status(400).json({ error: `placeholder_mapping["${key}"] with type "custom" requires a string "value"` });
        }
        if (map.type === 'field' && (typeof map.field !== 'string' || !map.field.trim())) {
          return res.status(400).json({ error: `placeholder_mapping["${key}"] with type "field" requires a "field" name (matching a custom column from your CSV)` });
        }
      }
    }
  }

  const insertPayload = {
    user_id: req.user.id,
    name,
    template_id: tpl.id,
    template_name: tpl.name,
    group_name: group_name?.trim() || null,
    status,
    total_contacts: contacts.length,
    queue_total: contacts.length,
    queue_processed: 0,
    queue_failed: 0,
    sent_count: 0,
    failed_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (isScheduled) insertPayload.schedule_at = scheduledAt.toISOString();
  if (placeholder_mapping && typeof placeholder_mapping === 'object' && Object.keys(placeholder_mapping).length) {
    insertPayload.placeholder_mapping = placeholder_mapping;
  }

  const { data: campaign, error: campErr } = await supabase
    .from('wb_campaigns')
    .insert(insertPayload)
    .select()
    .single();
  if (campErr) return res.status(500).json({ error: 'Failed to create campaign: ' + campErr.message });

  const queueItems = contacts.map(c => ({
    campaign_id: campaign.id,
    user_id: req.user.id,
    contact_id: c.id,
    phone: c.phone,
    contact_name: c.name || '',
    contact_message: c.message || null,
    custom_fields_data: c.custom_fields || null,
    template_name: tpl.name,
    template_language: tpl.language || 'en_US',
    status: 'pending',
    attempt_count: 0,
    created_at: new Date().toISOString()
  }));

  const { error: queueErr } = await supabase.from('wb_send_queue').insert(queueItems);
  if (queueErr) {
    // PostgREST errors carry more than .message — code/details/hint pinpoint
    // exactly what's wrong (e.g. PGRST204 = column not found in schema cache,
    // 23502 = not-null violation, 42501 = RLS policy block). Logging + returning
    // all of it turns "Failed to create queue: <vague message>" into an
    // actionable error instead of requiring a debugging session to find the cause.
    console.error('wb_send_queue insert failed:', {
      code: queueErr.code,
      message: queueErr.message,
      details: queueErr.details,
      hint: queueErr.hint
    });
    await supabase.from('wb_campaigns').delete().eq('id', campaign.id);
    return res.status(500).json({
      error: 'Failed to create queue: ' + queueErr.message,
      code: queueErr.code,
      details: queueErr.details,
      hint: queueErr.hint
    });
  }

  res.json({ success: true, campaign, total_contacts: contacts.length, message: `Campaign created with ${contacts.length} contacts queued.` });
});

app.post('/api/campaigns/:id/start', verifyUser, requirePermission('canManageCampaigns'), async (req, res) => {
  const { error } = await supabase
    .from('wb_campaigns')
    .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Campaign started' });
});

app.post('/api/campaigns/:id/pause', verifyUser, requirePermission('canManageCampaigns'), async (req, res) => {
  const { error } = await supabase
    .from('wb_campaigns')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Campaign paused' });
});

app.post('/api/campaigns/:id/stop', verifyUser, requirePermission('canManageCampaigns'), async (req, res) => {
  // Ownership check FIRST. Without this, any authenticated user who knows
  // (or guesses/enumerates) another user's campaign UUID could delete that
  // other user's pending queue rows below, since wb_send_queue.delete()
  // was previously filtered only by campaign_id — not by user_id — because
  // the service-role Supabase client bypasses RLS entirely and relies on
  // the app code to enforce ownership itself.
  const { data: owned, error: ownErr } = await supabase
    .from('wb_campaigns')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (ownErr || !owned) return res.status(404).json({ error: 'Campaign not found' });

  // Count pending items for refund
  const { count: pendingCount } = await supabase
    .from('wb_send_queue')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', req.params.id)
    .eq('status', 'pending');

  // Delete pending queue items
  await supabase.from('wb_send_queue').delete().eq('campaign_id', req.params.id).eq('status', 'pending');

  // Reset campaign to draft
  await supabase
    .from('wb_campaigns')
    .update({ status: 'draft', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  res.json({ success: true, message: 'Campaign stopped and reset to draft', refunded: pendingCount || 0 });
});

app.delete('/api/campaigns/:id', verifyUser, requirePermission('canManageCampaigns'), async (req, res) => {
  // Same ownership-first fix as /stop above — wb_send_queue and
  // wb_campaign_logs deletes were previously scoped by campaign_id alone.
  const { data: owned, error: ownErr } = await supabase
    .from('wb_campaigns')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (ownErr || !owned) return res.status(404).json({ error: 'Campaign not found' });

  await supabase.from('wb_send_queue').delete().eq('campaign_id', req.params.id);
  await supabase.from('wb_campaign_logs').delete().eq('campaign_id', req.params.id);
  const { error } = await supabase
    .from('wb_campaigns')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Campaign deleted' });
});

app.get('/api/campaigns/active', verifyUser, async (req, res) => {
  // Prefer whichever campaign is actually mid-flight. Ordering purely by
  // created_at could hand back a newer draft/scheduled campaign instead of
  // the one that's actually running, which left the Send tab pointed at the
  // wrong campaign (and stuck at 0/0/0/0) whenever more than one existed.
  const statusPriority = ['running', 'paused', 'queued', 'scheduled', 'draft'];
  const { data: candidates } = await supabase
    .from('wb_campaigns')
    .select('*')
    .eq('user_id', req.user.id)
    .in('status', statusPriority)
    .order('created_at', { ascending: false });

  if (candidates?.length) {
    candidates.sort((a, b) => statusPriority.indexOf(a.status) - statusPriority.indexOf(b.status));
    return res.json({ success: true, campaign: candidates[0] });
  }

  const { data: last } = await supabase
    .from('wb_campaigns')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();
  res.json({ success: true, campaign: last || null });
});

app.get('/api/campaigns/:id/status', verifyUser, async (req, res) => {
  let { data: campaign, error: campErr } = await supabase
    .from('wb_campaigns')
    .select('id, status, queue_total, queue_processed, queue_failed, sent_count, failed_count, total_contacts, user_id, schedule_at')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (campErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

  // Live counts straight from the queue — the source of truth. The counters on
  // wb_campaigns are only a cache; if one ever lags by a row the bar would show
  // N-1 and a running campaign would never complete. A claimed-but-unfinished
  // row ('processing') is shown as pending so sent+pending+failed always == total.
  let counts;
  try { counts = await getQueueCounts(req.params.id); }
  catch (e) { return res.status(500).json({ error: 'Could not read queue: ' + e.message }); }

  // Self-heal: everything is done but the campaign row still says running.
  if (campaign.status === 'running' && counts.outstanding === 0 && counts.total > 0) {
    await updateCampaignProgress(req.params.id);
    campaign = { ...campaign, status: 'completed' };
  }
  const pending = counts.outstanding;

  let gap_seconds = 0;
  let next_send_at = null;
  if (campaign.status === 'scheduled' && campaign.schedule_at) {
    next_send_at = campaign.schedule_at;
    const scheduledMs = new Date(campaign.schedule_at).getTime() - Date.now();
    gap_seconds = scheduledMs > 0 ? Math.ceil(scheduledMs / 1000) : 0;
  } else if (campaign.status === 'running' && counts.sent > 0) {
    const { data: settings } = await supabase
      .from('wb_settings')
      .select('max_gap')
      .eq('user_id', req.user.id)
      .single();
    const maxGap = settings?.max_gap || 15;
    const { data: lastSent } = await supabase
      .from('wb_send_queue')
      .select('sent_at')
      .eq('campaign_id', req.params.id)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();
    if (lastSent?.sent_at) {
      const secondsSinceLast = (Date.now() - new Date(lastSent.sent_at).getTime()) / 1000;
      if (secondsSinceLast < maxGap) {
        gap_seconds = Math.max(0, Math.ceil(maxGap - secondsSinceLast));
        next_send_at = new Date(Date.now() + gap_seconds * 1000).toISOString();
      }
    }
  }

  res.json({
    success: true, status: campaign.status,
    total: counts.total || campaign.queue_total || campaign.total_contacts || 0,
    sent: counts.sent,
    failed: counts.failed,
    pending: pending || 0, gap_seconds, next_send_at
  });
});

app.get('/api/campaigns/:id/logs', verifyUser, async (req, res) => {
  // Every recipient of the campaign with the exact text that was sent to them.
  // Paged (PostgREST caps a single response at 1000 rows) and the delivery
  // lookup is batched — it used to run one query per recipient (N+1), and used
  // .single(), which errors outright if two log rows ever shared a message id.
  const rows = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await supabase
      .from('wb_send_queue')
      .select('*')
      .eq('campaign_id', req.params.id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) return res.status(500).json({ error: error.message });
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
  }

  const deliveryById = new Map();
  const ids = rows.map(r => r.wa_message_id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('wb_campaign_logs')
      .select('*')
      .in('wa_message_id', ids.slice(i, i + 200));
    if (error) { console.error('[campaign-logs] delivery lookup failed:', error.message); break; }
    for (const d of (data || [])) deliveryById.set(d.wa_message_id, d);
  }

  const logs = rows.map(r => {
    const d = r.wa_message_id ? deliveryById.get(r.wa_message_id) : null;
    return {
      phone: r.phone,
      contact_name: r.contact_name,
      status: r.status,
      wa_message_id: r.wa_message_id,
      message_body: r.message_body || d?.message_body || '',
      error_reason: d?.error_reason || r.error_reason || null,
      created_at: r.created_at,
      sent_at: r.sent_at || d?.sent_at || null,
      delivery_status: d?.delivery_status || r.status,
      delivered_at: d?.delivered_at || null,
      read_at: d?.read_at || null
    };
  });
  res.json({ success: true, logs });
});

// ================================================================
// 10b. RECEIVED MESSAGES (inbound, via /webhook)
// ================================================================
app.get('/api/messages/received', verifyUser, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const [{ data: inbound, error: inErr }, { data: outbound, error: outErr }] = await Promise.all([
    supabase
      .from('wb_inbound_messages')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('wb_outbound_messages')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit)
  ]);
  if (inErr) return res.status(500).json({ error: inErr.message });
  if (outErr) return res.status(500).json({ error: outErr.message });

  // Merge both into one chronological thread. `direction` lets the client
  // tell an AI/bot/agent reply (out) apart from a customer message (in)
  // without guessing from field shape.
  const merged = [
    ...(inbound || []).map(m => ({ ...m, direction: 'in' })),
    ...(outbound || []).map(m => ({ ...m, direction: 'out' }))
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  // No .slice(limit) on the merged list: campaign sends are now logged as
  // outbound rows, and a burst of them is newer than the latest inbound
  // messages. Slicing here would push real inbound messages out of the response.

  const { count: unread } = await supabase
    .from('wb_inbound_messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .eq('is_read', false);

  res.json({ success: true, messages: merged, unread: unread || 0 });
});

// ---- Inbound audio / voice note streaming -------------------------------
// Meta only gives us a media id in the webhook. The real file is fetched on
// demand: GET /{media-id} -> short-lived URL -> download with the account's
// bearer token. The token never leaves the server. Meta keeps media ~30 days.
async function fetchMetaMedia(waAccount, mediaId) {
  const token = decryptToken(waAccount.access_token);
  const metaRes = await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) {
    const err = new Error(meta.error?.message || 'Could not resolve media');
    err.status = metaRes.status === 404 ? 404 : 502;
    throw err;
  }
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) {
    const err = new Error('Media download failed');
    err.status = fileRes.status === 404 ? 404 : 502;
    throw err;
  }
  const buffer = await fileRes.buffer();
  return { buffer, mime: meta.mime_type || fileRes.headers.get('content-type') || 'audio/ogg' };
}

// Resolves the WhatsApp account that received this row, then downloads its audio.
async function loadInboundAudio(row) {
  let acct = null;
  if (row.wa_account_id) {
    const { data } = await supabase.from('wa_accounts').select('*')
      .eq('id', row.wa_account_id).eq('user_id', row.user_id).maybeSingle();
    acct = data;
  }
  if (!acct) {
    const { data } = await supabase.from('wa_accounts').select('*')
      .eq('user_id', row.user_id).eq('is_active', true).limit(1).maybeSingle();
    acct = data;
  }
  if (!acct) { const e = new Error('No WhatsApp account found for this message'); e.status = 404; throw e; }
  return fetchMetaMedia(acct, row.media_id);
}

// Sends a buffer with HTTP Range support (Safari/iOS refuse to play audio without it).
function sendMediaBuffer(req, res, buffer, mime) {
  const total = buffer.length;
  res.set({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  });
  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (m && (m[1] || m[2])) {
    let start, end;
    if (m[1] === '') { start = Math.max(total - parseInt(m[2], 10), 0); end = total - 1; }
    else { start = parseInt(m[1], 10); end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1); }
    if (start > end || start >= total) {
      res.status(416).set('Content-Range', `bytes */${total}`);
      return res.end();
    }
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    return res.end(buffer.slice(start, end + 1));
  }
  res.set('Content-Length', total);
  return res.end(buffer);
}

app.get('/api/messages/received/:id/media', verifyUser, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { data: row, error } = await supabase
    .from('wb_inbound_messages')
    .select('id, user_id, wa_account_id, message_type, media_id')
    .eq('id', id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row || row.message_type !== 'audio' || !row.media_id) {
    return res.status(404).json({ error: 'No audio stored for this message' });
  }
  try {
    const { buffer, mime } = await loadInboundAudio(row);
    sendMediaBuffer(req, res, buffer, mime);
  } catch (err) {
    console.error('[media] audio fetch failed:', err.message);
    res.status(err.status || 502).json({ error: err.status === 404 ? 'Audio is no longer available (Meta keeps media ~30 days)' : 'Could not load audio' });
  }
});

app.post('/api/messages/received/mark-read', verifyUser, async (req, res) => {
  const { error } = await supabase
    .from('wb_inbound_messages')
    .update({ is_read: true })
    .eq('user_id', req.user.id)
    .eq('is_read', false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ================================================================
// 10c. PUSH TOKEN REGISTRATION (Android app, FCM)
// ================================================================
// Called once after the WebView login succeeds and again whenever
// Firebase rotates the token (FirebaseMessagingService.onNewToken).
// Upsert on (user_id, fcm_token) so re-registering the same token is a
// no-op rather than creating duplicate rows.
app.post('/api/push/register-token', verifyUser, async (req, res) => {
  const { fcm_token, platform } = req.body || {};
  if (!fcm_token) return res.status(400).json({ error: 'fcm_token is required' });

  const { error } = await supabase
    .from('wb_device_tokens')
    .upsert(
      { user_id: req.user.id, fcm_token, platform: platform || 'android', updated_at: new Date().toISOString() },
      { onConflict: 'user_id,fcm_token' }
    );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Called on logout so a signed-out device stops receiving pushes for
// the account it just left.
app.post('/api/push/unregister-token', verifyUser, async (req, res) => {
  const { fcm_token } = req.body || {};
  if (!fcm_token) return res.status(400).json({ error: 'fcm_token is required' });

  const { error } = await supabase
    .from('wb_device_tokens')
    .delete()
    .eq('user_id', req.user.id)
    .eq('fcm_token', fcm_token);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Manual free-form reply, only valid within WhatsApp's 24-hour customer
// service window (https://developers.facebook.com/docs/whatsapp/...).
// We use a 22-hour cutoff here — a safety margin under Meta's real 24h
// limit to absorb clock drift/latency between Meta's timestamp and this
// check. The window is measured from the CONTACT'S most recent inbound
// message (each new inbound message resets it), not from first contact.
// Enforced server-side too, not just via a disabled button in the UI —
// a stale button state or a direct API call shouldn't be able to bypass it.
const REPLY_WINDOW_HOURS = 22;

app.post('/api/messages/reply', verifyUser, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message?.trim()) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  const { data: lastInbound, error: lastErr } = await supabase
    .from('wb_inbound_messages')
    .select('created_at')
    .eq('user_id', req.user.id)
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (lastErr || !lastInbound) {
    return res.status(400).json({ error: 'No inbound message found for this contact' });
  }

  const hoursSince = (Date.now() - new Date(lastInbound.created_at).getTime()) / 3600000;
  if (hoursSince > REPLY_WINDOW_HOURS) {
    return res.status(403).json({
      error: `Reply window has closed (${hoursSince.toFixed(1)}h since their last message, limit is ${REPLY_WINDOW_HOURS}h). Use an approved template instead.`
    });
  }

  const { data: waAccounts } = await supabase
    .from('wa_accounts')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!waAccounts?.length) {
    return res.status(400).json({ error: 'No active WhatsApp account connected' });
  }
  const waAccount = waAccounts[0];

  try {
    const plainToken = decryptToken(waAccount.access_token);
    const result = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: message.trim() }
        })
      }
    );
    const responseData = await result.json();
    if (!result.ok || !responseData.messages?.[0]?.id) {
      return res.status(502).json({ error: responseData.error?.message || `Meta API ${result.status}` });
    }
    logOutboundMessage({
      userId: req.user.id, waAccountId: waAccount.id, phone,
      messageType: 'text', messageBody: message.trim(),
      waMessageId: responseData.messages[0].id, source: 'manual'
    });
    res.json({ success: true, wa_message_id: responseData.messages[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 10b. INTERACTIVE MESSAGE TEMPLATES (buttons / lists / cta_url)
// Free-form messages sendable within the same 24h session window as
// /api/messages/reply above — reuses the same REPLY_WINDOW_HOURS check.
// ================================================================

app.get('/api/interactive-templates', verifyUser, async (req, res) => {
  try {
    const templates = await interactiveTemplates.listTemplates(req.user.id);
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/interactive-templates', verifyUser, async (req, res) => {
  const { name, kind, config } = req.body || {};
  if (!name || !kind || !config) {
    return res.status(400).json({ error: 'name, kind, and config are required' });
  }
  try {
    const template = await interactiveTemplates.createTemplate(req.user.id, { name, kind, config });
    res.json({ success: true, template });
  } catch (err) {
    const status = err instanceof WhatsAppValidationError ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.delete('/api/interactive-templates/:id', verifyUser, async (req, res) => {
  try {
    await interactiveTemplates.deleteTemplate(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview-only: rewrites a template's copy per a free-text instruction via
// AI, re-validates the result, and returns it WITHOUT sending anything.
// The UI should show this as an editable preview before the user hits Send.
app.post('/api/interactive-templates/:id/customize-ai', verifyUser, async (req, res) => {
  const { instruction, model } = req.body || {};
  if (!instruction || !instruction.trim()) {
    return res.status(400).json({ error: 'instruction is required' });
  }
  try {
    const template = await interactiveTemplates.getTemplate(req.user.id, req.params.id);
    const customizedConfig = await interactiveTemplates.customizeTemplateWithAI({
      generateReply,
      kind: template.kind,
      config: template.config,
      instruction,
      model: model || DEFAULT_AI_MODEL,
    });
    res.json({ success: true, kind: template.kind, config: customizedConfig });
  } catch (err) {
    const status = err instanceof WhatsAppValidationError ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Sends a free-form interactive (or text) reply within the 24h session
// window. Two ways to call it:
//   1) { phone, kind, config, vars }        — build from a template/config
//   2) { phone, raw_interactive: {...} }     — power-user manual JSON,
//      passed straight through as the `interactive` block after a basic
//      shape check. Useful for pasting a payload copied from Meta's docs
//      or from the wa-json-builder library directly.
app.post('/api/messages/reply-interactive', verifyUser, async (req, res) => {
  const { phone, kind, config, vars, raw_interactive } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (!kind && !raw_interactive) {
    return res.status(400).json({ error: 'Provide either { kind, config } or { raw_interactive }' });
  }

  // Same 24h session-window enforcement as /api/messages/reply
  const { data: lastInbound, error: lastErr } = await supabase
    .from('wb_inbound_messages')
    .select('created_at')
    .eq('user_id', req.user.id)
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (lastErr || !lastInbound) {
    return res.status(400).json({ error: 'No inbound message found for this contact' });
  }
  const hoursSince = (Date.now() - new Date(lastInbound.created_at).getTime()) / 3600000;
  if (hoursSince > REPLY_WINDOW_HOURS) {
    return res.status(403).json({
      error: `Reply window has closed (${hoursSince.toFixed(1)}h since their last message, limit is ${REPLY_WINDOW_HOURS}h). Use an approved template instead.`
    });
  }

  const { data: waAccounts } = await supabase
    .from('wa_accounts')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!waAccounts?.length) {
    return res.status(400).json({ error: 'No active WhatsApp account connected' });
  }
  const waAccount = waAccounts[0];

  let payload;
  try {
    if (raw_interactive) {
      if (!raw_interactive.type) {
        return res.status(400).json({ error: 'raw_interactive.type is required (e.g. "button", "list", "cta_url")' });
      }
      payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: raw_interactive,
      };
    } else {
      payload = buildMessagePayload(kind, config, phone, vars || {});
    }
  } catch (err) {
    const status = err instanceof WhatsAppValidationError ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }

  try {
    const plainToken = decryptToken(waAccount.access_token);
    const result = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
        body: JSON.stringify(payload),
      }
    );
    const responseData = await result.json();
    if (!result.ok || !responseData.messages?.[0]?.id) {
      return res.status(502).json({ error: responseData.error?.message || `Meta API ${result.status}` });
    }
    {
      const { message_type, message_body } = extractOutboundPreview(payload);
      logOutboundMessage({
        userId: req.user.id, waAccountId: waAccount.id, phone,
        messageType: message_type, messageBody: message_body,
        waMessageId: responseData.messages[0].id, source: 'manual'
      });
    }
    res.json({ success: true, wa_message_id: responseData.messages[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 11. WA ACCOUNTS ROUTES
// ================================================================
app.get('/api/wa/accounts', verifyUser, async (req, res) => {
  const { data, error } = await supabase
    .from('wa_accounts')
    .select('id, waba_id, phone_number_id, phone_number, display_name, quality_rating, is_active, created_at')
    .eq('user_id', req.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, accounts: data || [] });
});

app.delete('/api/wa/accounts/:id', verifyUser, async (req, res) => {
  const { error } = await supabase
    .from('wa_accounts')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Number disconnected' });
});

// Pulls the current quality_rating (and display name) for every one of the
// user's connected numbers straight from Meta, rather than trusting
// whatever was last saved locally — quality can drift up/down over time
// based on recent sending behavior, independent of any action taken here.
app.post('/api/wa/accounts/refresh-quality', verifyUser, async (req, res) => {
  const { data: accounts, error } = await supabase
    .from('wa_accounts')
    .select('id, phone_number_id, access_token')
    .eq('user_id', req.user.id)
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  if (!accounts?.length) return res.json({ success: true, updated: 0, accounts: [] });

  const results = await Promise.all(accounts.map(async (acc) => {
    try {
      const plainToken = decryptToken(acc.access_token);
      const metaRes = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${acc.phone_number_id}?fields=quality_rating,verified_name,display_phone_number`,
        { headers: { 'Authorization': `Bearer ${plainToken}` } }
      );
      const metaData = await metaRes.json();
      if (!metaRes.ok) {
        return { id: acc.id, ok: false, error: metaData.error?.message || `Meta API ${metaRes.status}` };
      }
      const { error: updateErr } = await supabase
        .from('wa_accounts')
        .update({
          quality_rating: metaData.quality_rating || 'UNKNOWN',
          display_name: metaData.verified_name || undefined,
          updated_at: new Date().toISOString()
        })
        .eq('id', acc.id);
      if (updateErr) {
        console.error('[refresh-quality] failed to save for account', acc.id, updateErr);
        return { id: acc.id, ok: false, error: updateErr.message };
      }
      return { id: acc.id, ok: true, quality_rating: metaData.quality_rating || 'UNKNOWN' };
    } catch (err) {
      return { id: acc.id, ok: false, error: err.message };
    }
  }));

  const { data: refreshed } = await supabase
    .from('wa_accounts')
    .select('id, waba_id, phone_number_id, phone_number, display_name, quality_rating, is_active, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  res.json({
    success: true,
    updated: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok),
    accounts: refreshed || []
  });
});

// SECURITY FIX: this route proxies an arbitrary access_token straight to
// Meta's Graph API and echoes the result back. Without verifyUser it was an
// unauthenticated, unrate-limited oracle anyone on the internet could use to
// test whether a WhatsApp Business token/WABA pair is valid — a classic
// credential-checking abuse pattern that gets sites flagged by Safe Browsing.
app.post('/api/wa/manual/verify', verifyUser, async (req, res) => {
  const { waba_id, access_token } = req.body;
  if (!waba_id || !access_token) return res.status(400).json({ error: 'waba_id and access_token required' });
  try {
    const phoneRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });
    const numbers = (phoneData.data || []).map(p => ({
      phone_number_id: p.id, phone_number: p.display_phone_number,
      display_name: p.verified_name, quality_rating: p.quality_rating || 'UNKNOWN',
      verified: p.code_verification_status === 'VERIFIED'
    }));
    if (!numbers.length) return res.status(400).json({ error: 'No phone numbers found under this WABA.' });
    res.json({ success: true, numbers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wa/manual/save', verifyUser, async (req, res) => {
  const { waba_id, phone_number_id, access_token } = req.body;
  if (!waba_id || !phone_number_id || !access_token) return res.status(400).json({ error: 'Missing required fields' });
  try {
    // Fetch phone details
    const phoneRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const phoneData = await phoneRes.json();
    if (phoneData.error) return res.status(400).json({ error: phoneData.error.message });

    // Subscribe to webhooks
    const subRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/subscribed_apps`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const subData = await subRes.json();

    // Encrypt token
    const encryptedToken = encryptToken(access_token);

    // Insert new account
    const { data: inserted, error: insertErr } = await supabase
      .from('wa_accounts')
      .insert({
        user_id: req.user.id, waba_id, phone_number_id,
        phone_number: phoneData.display_phone_number,
        display_name: phoneData.verified_name,
        access_token: encryptedToken,
        quality_rating: phoneData.quality_rating || 'GREEN',
        is_active: true, messages_sent_today: 0,
        last_reset_date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      })
      .select('id')
      .single();
    if (insertErr) return res.status(500).json({ error: 'Failed to save account' });

    res.json({
      success: true, account_id: inserted.id,
      phone_number: phoneData.display_phone_number,
      display_name: phoneData.verified_name,
      webhook_subscribed: !subData.error
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 11b. BILLING (real Meta charges via pricing_analytics)
// ================================================================
// Pulls actual per-message cost/volume from Meta's pricing_analytics field
// (WABA-level Graph API insight), broken down by pricing_category
// (marketing/utility/authentication/service) and pricing_type:
//   REGULAR               -> billable, business-initiated
//   FREE_CUSTOMER_SERVICE  -> free, sent inside the 24h reply window
//   FREE_ENTRY_POINT       -> free, sent inside a 72h ad/CTA click-in window
// NOTE: verified against a live WABA response on 2026-07-05. Meta's
// pricing_analytics.data is an array of groups, each containing a nested
// data_points[] array with the actual {start, end, cost, volume,
// pricing_category, pricing_type} rows — this nesting isn't obvious from
// Meta's docs prose, so don't "simplify" this back to a flat array later.
app.get('/api/billing/analytics', verifyUser, async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'month';
  const now = new Date();
  let start;
  if (period === 'day') {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    start = new Date(now); start.setDate(now.getDate() - 6); start.setHours(0, 0, 0, 0);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(now.getTime() / 1000);

  const { data: accounts, error } = await supabase
    .from('wa_accounts')
    .select('waba_id, phone_number_id, access_token')
    .eq('user_id', req.user.id)
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  if (!accounts?.length) {
    return res.json({ success: true, period, start: startTs, end: endTs, rows: [], errors: [] });
  }

  // A single WABA can own multiple connected numbers — group so we call
  // Meta once per WABA (scoped to just this user's connected numbers via
  // phone_numbers filter), not once per number.
  const byWaba = {};
  for (const acc of accounts) {
    if (!acc.waba_id) continue;
    if (!byWaba[acc.waba_id]) byWaba[acc.waba_id] = { access_token: acc.access_token, phoneNumberIds: [] };
    byWaba[acc.waba_id].phoneNumberIds.push(acc.phone_number_id);
  }

  const rows = [];
  const errors = [];
  await Promise.all(Object.entries(byWaba).map(async ([wabaId, info]) => {
    try {
      const plainToken = decryptToken(info.access_token);
      // NOTE: do NOT add a .phone_numbers(...) filter here — verified live
      // against Meta's API that including it causes pricing_analytics to
      // come back empty/zeroed for this WABA. The confirmed-working query
      // omits phone number scoping entirely and relies on WABA-level totals.
      const fieldsExpr =
        `pricing_analytics.start(${startTs}).end(${endTs}).granularity(DAILY)` +
        `.metric_types(["COST","VOLUME"])` +
        `.dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
      const url = `https://graph.facebook.com/${META_API_VERSION}/${wabaId}?fields=${encodeURIComponent(fieldsExpr)}`;
      const metaRes = await fetch(url, { headers: { 'Authorization': `Bearer ${plainToken}` } });
      const metaData = await metaRes.json();
      if (!metaRes.ok) {
        errors.push({ waba_id: wabaId, error: metaData.error?.message || `Meta API ${metaRes.status}` });
        return;
      }
      // pricing_analytics.data is an array of groups, each wrapping the
      // actual rows in a nested data_points[] array — confirmed against a
      // live response; this is NOT documented explicitly by Meta's docs text.
      const groups = metaData.pricing_analytics?.data || [];
      for (const group of groups) {
        for (const dp of (group.data_points || [])) {
          rows.push({
            waba_id: wabaId,
            start: dp.start, end: dp.end,
            cost: Number(dp.cost) || 0,
            volume: Number(dp.volume) || 0,
            pricing_category: dp.pricing_category || 'UNKNOWN',
            pricing_type: dp.pricing_type || 'UNKNOWN'
          });
        }
      }
    } catch (err) {
      errors.push({ waba_id: wabaId, error: err.message });
    }
  }));

  res.json({ success: true, period, start: startTs, end: endTs, rows, errors });
});


// ================================================================
// 12. EXTERNAL API (n8n / Zapier)
// ================================================================
app.post('/api/external/send', verifyUser, requirePermission('canSendMessages'), requireScopedAccount(), async (req, res) => {
  const { phone_number_id, to, template_name, language_code, components } = req.body;
  if (!phone_number_id || !to || !template_name) {
    return res.status(400).json({ error: 'phone_number_id, to, and template_name required' });
  }
  // `components` lets callers pass template variables, e.g.:
  // "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "Sanjay" }] }]
  // or, for named variables: [{ "type": "text", "parameter_name": "a", "text": "Sanjay" }]
  if (components !== undefined && !Array.isArray(components)) {
    return res.status(400).json({ error: 'components must be an array when provided' });
  }
  try {
    const { data: acc } = await supabase
      .from('wa_accounts')
      .select('access_token')
      .eq('phone_number_id', phone_number_id)
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .single();
    if (!acc) return res.status(404).json({ error: 'Phone number not found or inactive' });

    const plainToken = decryptToken(acc.access_token);
    const templatePayload = { name: template_name, language: { code: language_code || 'en_US' } };
    if (components?.length) templatePayload.components = components;

    const metaRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to,
          type: 'template',
          template: templatePayload
        })
      }
    );
    const data = await metaRes.json();
    if (metaRes.ok) res.json({ success: true, message_id: data.messages?.[0]?.id });
    else res.status(metaRes.status).json({ error: data.error?.message || 'Meta API error' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 13. META WEBHOOKS
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
  res.sendStatus(200); // Must respond immediately

  // Verify signature — if META_APP_SECRET is configured, a valid signature is mandatory.
  // (Previously this only checked when a signature header happened to be present,
  // so a request with the header stripped would sail through unverified.)
  // signatureValid stays true (i.e. "not required") when no secret is configured,
  // and we no longer bail out silently on failure — the attempt is logged below
  // first so rejected deliveries are still visible for debugging, THEN skipped.
  let signatureValid = true;
  let signatureReason = null;
  if (process.env.META_APP_SECRET) {
    const sigHeader = req.headers['x-hub-signature-256'] || '';
    if (!sigHeader) {
      signatureValid = false;
      signatureReason = 'missing x-hub-signature-256 header';
    } else {
      const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex');
      try {
        const sigBuf = Buffer.from(sigHeader);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
          signatureValid = false;
          signatureReason = 'signature mismatch';
        }
      } catch (_) {
        signatureValid = false;
        signatureReason = 'signature comparison error';
      }
    }
    if (!signatureValid) console.warn('[webhook] rejected:', signatureReason);
  } else {
    console.warn('[webhook] META_APP_SECRET not set — skipping signature verification (INSECURE, set it in production)');
  }

  const body = req.body;

  for (const entry of (body?.entry || [])) {
    for (const change of (entry.changes || [])) {
      console.log('[webhook] incoming:', JSON.stringify({
        waba_id: entry.id,
        field: change.field,
        value: change.value
      }, null, 2));
    }
  }

  // Fire-and-forget audit log of every delivery Meta sends us, valid or not,
  // so webhook issues (missed events, bad signatures, unexpected payload
  // shapes) can be diagnosed after the fact instead of only via console.log.
  supabase.from('wb_webhook_logs').insert({
    waba_id: body?.entry?.[0]?.id || null,
    object_type: body?.object || null,
    fields: [...new Set((body?.entry || []).flatMap(e => (e.changes || []).map(c => c.field)))],
    signature_valid: signatureValid,
    reject_reason: signatureReason,
    payload: body,
    created_at: new Date().toISOString()
  }).then(({ error }) => {
    if (error) console.error('[webhook] failed to write webhook log:', error.message);
  });

  if (!signatureValid) return;
  // Facebook Page messages and Instagram DMs arrive with object: 'page' /
  // 'instagram' respectively, in a completely different shape (entry[].messaging[])
  // than WhatsApp's entry[].changes[].value.messages. Previously this handler
  // returned immediately for anything that wasn't a WhatsApp payload, so no
  // FB/IG inbound message — including ecom cart taps and catalog triggers —
  // ever reached any handler. Only the ecom-relevant slice of that traffic is
  // wired up for now (see handleIncomingMessengerEvent) — full bot-builder
  // parity (AI auto-reply, saved templates) for these two channels is a
  // separate, larger piece of work.
  if (body.object === 'page' || body.object === 'instagram') {
    const channel = body.object === 'instagram' ? 'instagram' : 'facebook';
    for (const entry of (body.entry || [])) {
      for (const messagingEvent of (entry.messaging || [])) {
        handleIncomingMessengerEvent(channel, entry.id, messagingEvent).catch((err) => {
          console.error(`[webhook] ${channel} event handling error:`, err.message);
        });
      }
    }
    return;
  }

  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      const field = change.field;
      const value = change.value;

      if (field === 'messages') {
        // Incoming messages from customers (trigger auto-reply if enabled)
        for (const msg of (value?.messages || [])) {
          handleIncomingMessage(value, msg).catch((err) => {
            console.error('[webhook] auto-reply error:', err.message);
          });
        }

        // Delivery statuses
        for (const status of (value?.statuses || [])) {
          try {
            await applyDeliveryStatus(status);
          } catch (err) {
            console.error('[webhook] delivery status handling failed:', status?.id, err.message);
          }
        }
      } else if (field === 'message_template_status_update') {
        const newStatus = value.event === 'APPROVED' ? 'APPROVED' 
                        : value.event === 'REJECTED' ? 'REJECTED' 
                        : 'PENDING';
        // entry.id is the WABA this event belongs to. Without resolving it
        // to the owning user_id, matching by meta_template_id/name alone
        // could update a DIFFERENT user's template if they happened to pick
        // the same template name (names aren't globally unique, only unique
        // per-WABA) — a cross-tenant data-integrity bug, since the service
        // role client bypasses RLS and nothing else scoped this query.
        const { data: owningAccount } = await supabase
          .from('wa_accounts')
          .select('user_id')
          .eq('waba_id', entry.id)
          .single();
        if (owningAccount?.user_id) {
          await supabase
            .from('wb_templates')
            .update({ 
              status: newStatus, 
              meta_error: value.reason || null,
              updated_at: new Date().toISOString() 
            })
            .eq('user_id', owningAccount.user_id)
            .or(`meta_template_id.eq.${value.message_template_id || 'null'},name.eq.${value.message_template_name || 'null'}`);
        } else {
          console.warn('[webhook] template_status_update: no wa_account found for WABA', entry.id);
        }
      } else {
        // TEMPORARY diagnostic branch — catches account_update and anything
        // else not explicitly handled above, so we can see the real payload
        // shape. Remove once account_update handling is built for real.
        console.log(`[webhook] UNHANDLED field "${field}" for WABA ${entry.id}:`);
        console.log(JSON.stringify(value, null, 2));
      }
    }
  }
});

// Pulls a readable preview + type out of any inbound WhatsApp message payload,
// not just text (images, documents, locations, buttons, etc. all show up in
// the Received tab, they just don't trigger the AI auto-reply).
function extractMessagePreview(msg) {
  switch (msg.type) {
    case 'text':
      return { message_type: 'text', message_body: msg.text?.body || '' };
    case 'image':
      return { message_type: 'image', message_body: msg.image?.caption || '📷 Image' };
    case 'video':
      return { message_type: 'video', message_body: msg.video?.caption || '🎥 Video' };
    case 'audio':
      return { message_type: 'audio', message_body: msg.audio?.voice ? '🎤 Voice message' : '🎵 Audio message' };
    case 'document':
      return { message_type: 'document', message_body: msg.document?.filename || '📄 Document' };
    case 'sticker':
      return { message_type: 'sticker', message_body: '🩹 Sticker' };
    case 'location':
      return { message_type: 'location', message_body: `📍 Location (${msg.location?.latitude}, ${msg.location?.longitude})` };
    case 'button':
      return { message_type: 'button', message_body: msg.button?.text || 'Button reply' };
    case 'interactive':
      return {
        message_type: 'interactive',
        message_body: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || 'Interactive reply'
      };
    default:
      return { message_type: msg.type || 'unknown', message_body: `[${msg.type || 'unsupported'} message]` };
  }
}

// Same idea as extractMessagePreview above, but for a payload WE are about
// to send (the Graph API request body), not one we received. Used so the
// conversation thread shows the actual sent text/interactive body instead
// of a generic placeholder like "[template auto-reply]" or "[bot rule
// <uuid>] template reply" — those placeholders were never meant to be the
// final content, they were left in as a stand-in when outbound logging was
// first wired up and never replaced with the real text.
function extractOutboundPreview(payload) {
  if (!payload) return { message_type: 'text', message_body: '' };
  switch (payload.type) {
    case 'text':
      return { message_type: 'text', message_body: payload.text?.body || '' };
    case 'image':
      return { message_type: 'image', message_body: payload.image?.caption || '📷 Image' };
    case 'interactive': {
      const interactive = payload.interactive || {};
      const bodyText = interactive.body?.text || '';
      switch (interactive.type) {
        case 'button': {
          const labels = (interactive.action?.buttons || []).map(b => b.reply?.title).filter(Boolean).join(' / ');
          return { message_type: 'button', message_body: labels ? `${bodyText}\n[${labels}]` : bodyText };
        }
        case 'list': {
          const label = interactive.action?.button || '';
          return { message_type: 'list', message_body: label ? `${bodyText}\n[${label}]` : bodyText };
        }
        case 'cta_url': {
          const label = interactive.action?.parameters?.display_text || '';
          return { message_type: 'cta_url', message_body: label ? `${bodyText}\n[${label}]` : bodyText };
        }
        default:
          return { message_type: interactive.type || 'interactive', message_body: bodyText || '[interactive message]' };
      }
    }
    default:
      return { message_type: payload.type || 'unknown', message_body: `[${payload.type || 'unsupported'} message]` };
  }
}

// Persists a message WE sent (AI auto-reply, bot-builder rule, template
// auto-reply, or a human agent's manual reply) so it shows up in the
// conversation thread alongside inbound messages. Previously nothing sent
// this way was ever saved — replies went straight to the Graph API and the
// only trace of them was an optimistic, client-side-only bubble in
// mobile.html that disappeared on refresh or wasn't visible from crm.html
// or a second device at all. Fire-and-forget: a logging failure should
// never block or fail the actual send.
async function logOutboundMessage({ userId, waAccountId = null, phone, contactName = '', messageType = 'text', messageBody = '', waMessageId = null, source, campaignId = null }) {
  try {
    const row = {
      user_id: userId,
      wa_account_id: waAccountId,
      phone,
      contact_name: contactName,
      message_type: messageType,
      message_body: messageBody,
      wa_message_id: waMessageId,
      source, // 'manual' | 'ai_auto_reply' | 'template_auto_reply' | 'bot_builder' | 'campaign'
      created_at: new Date().toISOString()
    };
    if (campaignId) row.campaign_id = campaignId;
    let { error } = await supabase.from('wb_outbound_messages').insert(row);
    if (error && campaignId && isMissingColumnError(error)) {
      warnMigrationOnce('wb_outbound_messages.campaign_id');
      delete row.campaign_id;
      ({ error } = await supabase.from('wb_outbound_messages').insert(row));
    }
    if (error) console.error('[outbound-log] failed to store sent message:', error.message);
  } catch (err) {
    console.error('[outbound-log] failed to store sent message:', err.message);
  }
}

// Handles a single incoming WhatsApp message: logs it (all types, so it shows
// up in the Received tab) and, for plain text only, checks the account's
// auto-reply setting, asks the configured AI model for a reply, and sends it back.
// Handles a tap on an ecom-flow button/list row/postback/quick-reply (ids
// like "ecom_add:<id>", "ecom_view_cart", "ecom_checkout", "ecom_clear").
// Runs BEFORE bot-engine's keyword rules — these are direct cart actions
// from a specific tap, not something a keyword match should ever intercept.
//
// Channel-agnostic as of the FB/IG ecom rollout: WhatsApp still sends
// directly via wa_accounts' own phone_number_id + token (unchanged, `waAccount`
// is required for that channel); Instagram/Facebook send through
// ecomChannelSender.sendRawMessengerPayload, which resolves the merchant's
// Page access token itself (see src/channel-send.js) — no per-channel token
// plumbing needed here beyond passing `userId`.
async function handleEcomInteraction({ channel, userId, from, contactName, replyId, waAccount = null }) {
  async function send(payload) {
    if (channel === 'whatsapp') {
      const plainToken = decryptToken(waAccount.access_token);
      const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
        body: JSON.stringify(payload)
      });
      const responseData = await result.json().catch(() => ({}));
      if (result.ok) {
        const { message_type, message_body } = extractOutboundPreview(payload);
        logOutboundMessage({
          userId, waAccountId: waAccount.id, phone: from,
          contactName, messageType: message_type, messageBody: message_body,
          waMessageId: responseData?.messages?.[0]?.id || null, source: 'bot_builder'
        });
      } else {
        console.error('[webhook] ecom send failed:', responseData?.error?.message || result.status);
      }
      return;
    }

    // instagram / facebook — `payload` here is already the full
    // { recipient: { id }, message: {...} } shape ecom/messages.js's
    // builders return for these channels, so it can go straight through.
    // No wb_outbound_messages row is written for these two channels yet
    // (that table's columns are WhatsApp-shaped — wa_account_id/wa_message_id)
    // — a fair follow-up if unified outbound logging across channels is
    // needed later, but not required for the cart/checkout flow to work.
    try {
      await ecomChannelSender.sendRawMessengerPayload(userId, payload);
    } catch (err) {
      console.error(`[webhook] ecom send failed (${channel}):`, err.message);
    }
  }

  const { data: settings } = await supabase.from('wb_ecom_settings').select('*').eq('user_id', userId).maybeSingle();
  const currency = settings?.currency || 'INR';
  const checkoutLabel = settings?.checkout_button_label || 'Checkout';
  const provider = settings?.default_provider || 'cashfree';

  if (replyId.startsWith('ecom_add:')) {
    const productId = replyId.slice('ecom_add:'.length);
    const { data: product } = await supabase.from('wb_products').select('name').eq('id', productId).single();
    await ecomCart.addItem(userId, channel, from, productId, 1, contactName);
    const summary = await ecomCart.getSummary(userId, channel, from);
    await send(ecomMessages.buildAddedToCartMessage(channel, from, product?.name || 'Item', summary, currency));
    return;
  }

  if (replyId === 'ecom_view_cart') {
    const summary = await ecomCart.getSummary(userId, channel, from);
    await send(ecomMessages.buildCartSummaryMessage(channel, from, summary, checkoutLabel, currency));
    return;
  }

  if (replyId === 'ecom_clear') {
    const summary = await ecomCart.getSummary(userId, channel, from);
    if (summary.cart) await ecomCart.clearCart(summary.cart.id);
    const clearedText = 'Cart cleared. Say "shop" to browse products again!';
    await send(channel === 'whatsapp'
      ? { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: clearedText } }
      : { recipient: { id: from }, message: { text: clearedText } });
    return;
  }

  if (replyId === 'ecom_checkout') {
    const { order, items } = await ecomCart.checkoutCart(userId, channel, from, currency);
    const checkoutResult = await ecomPayments.createCheckout({
      order: { ...order, provider, user_id: userId }, items,
      successUrl: `${SELF_URL}/ecom-pay.html?order_id=${order.id}&status=success`,
      cancelUrl: `${SELF_URL}/ecom-pay.html?order_id=${order.id}&status=cancel`,
    });
    await supabase.from('wb_orders').update({ provider, provider_order_id: checkoutResult.provider_order_id }).eq('id', order.id);
    // Razorpay has no redirect URL of its own (Checkout.js is a client-side
    // widget, not a hosted page) — point at this repo's own /ecom-pay.html,
    // which mounts Checkout.js using the order's client_fields, instead.
    const payUrl = checkoutResult.checkout_url || `${SELF_URL}/ecom-pay.html?order_id=${order.id}`;
    await send(ecomMessages.buildCheckoutLinkMessage(channel, from, payUrl));
    return;
  }
}

// Resolves which merchant (user_id) owns an inbound Facebook Page or
// Instagram professional-account webhook event, given the Page/IG id Meta
// sends as entry[].id. Mirrors the WhatsApp path's phone_number_id -> wa_accounts
// -> user_id lookup, but there's no dedicated table for this yet — Page
// tokens are stored per-user in wb_oauth_tokens.metadata.pages (populated by
// src/routes/flows.js's Facebook OAuth callback), so this scans that column
// for a matching page id. Fine at today's scale; if this becomes a hot path
// with many connected merchants, worth adding a dedicated
// wb_page_id -> user_id index table instead of scanning on every webhook hit.
//
// KNOWN GAP: this only matches on the Facebook Page's own `id`. Instagram
// webhook events are keyed by the Page's *linked Instagram professional
// account* id, which is a different id that flows.js's OAuth callback
// doesn't currently fetch/store (it only calls /me/accounts, not each page's
// `instagram_business_account` field). Until flows.js is updated to also
// capture that id, Instagram inbound events for a given merchant won't
// resolve here — Facebook Page events will. Flagging this so it isn't
// silently assumed to already work.
async function resolveEcomUserFromPageId(pageOrIgId) {
  const { data: rows, error } = await supabase.from('wb_oauth_tokens').select('user_id, metadata').eq('service', 'facebook');
  if (error || !rows) return null;
  for (const row of rows) {
    const pages = row.metadata?.pages || [];
    const match = pages.find((p) => p.id === pageOrIgId || p.instagram_business_account?.id === pageOrIgId);
    if (match) return { userId: row.user_id, page: match };
  }
  return null;
}

// Handles one inbound Messenger-platform event (Facebook Page message or
// Instagram DM — both arrive in this same `messaging[]` shape). Only the
// ecom-specific slice of bot behavior is wired here: a tap on an ecom
// postback/quick-reply, or a plain-text message matching an `ecom_catalog`
// bot-builder rule. Full bot-builder parity for these two channels (AI
// auto-reply, saved templates) is a separate, larger piece of work and is
// NOT handled here yet — a matched non-ecom rule is logged and skipped
// rather than silently mishandled.
async function handleIncomingMessengerEvent(channel, pageOrIgId, messagingEvent) {
  const resolved = await resolveEcomUserFromPageId(pageOrIgId);
  if (!resolved) return; // no merchant connected for this Page/IG account
  const { userId } = resolved;
  const from = messagingEvent.sender?.id;
  if (!from) return;

  let contactName = '';
  try {
    const column = channel === 'instagram' ? 'ig_handle' : 'fb_psid';
    const { data: lead } = await supabase.from('wb_leads').select('name').eq('user_id', userId).eq(column, from).maybeSingle();
    if (lead?.name) contactName = lead.name;
  } catch (_) { /* no matching lead, that's fine */ }

  // Postback button tap (generic-template "Add to Cart" card buttons) or a
  // quick_reply tap (Checkout/Clear cart/View Cart) — both carry the same
  // "ecom_..." payload convention as WhatsApp's button/list reply ids.
  const replyId = messagingEvent.postback?.payload || messagingEvent.message?.quick_reply?.payload;
  if (replyId && replyId.startsWith('ecom_')) {
    try {
      await handleEcomInteraction({ channel, userId, from, contactName, replyId });
    } catch (err) {
      console.error(`[webhook] ecom interaction failed (${channel}):`, err.message);
    }
    return;
  }

  // Plain text — only checked against ecom_catalog bot-builder rules for now
  // (see comment above); any other rule type that matches is intentionally
  // left unhandled here rather than guessing at FB/IG-specific AI/template behavior.
  const text = messagingEvent.message?.text;
  if (!text || messagingEvent.message?.is_echo) return;

  let match = null;
  try {
    match = await matchRule({ supabase, getValidGoogleAccessToken }, { userId, phone: from, text });
  } catch (err) {
    console.error(`[webhook] bot-engine matchRule failed (${channel}):`, err.message);
  }
  if (!match) return;

  if (match.actionType !== 'ecom_catalog') {
    console.log(`[webhook] ${channel} matched a non-ecom rule (actionType=${match.actionType}) — not sent; FB/IG bot-builder parity beyond ecom_catalog isn't wired up yet.`);
    return;
  }

  // A rule can restrict itself to specific channels via action_config.channels
  // (e.g. a "WhatsApp only" catalog trigger) — set from the ecom-builder UI's
  // per-channel checkboxes. Omitted/empty means "all channels", matching the
  // original behavior before per-channel scoping existed.
  const ruleChannels = match.actionConfig?.channels;
  if (Array.isArray(ruleChannels) && ruleChannels.length && !ruleChannels.includes(channel)) return;

  try {
    const productIds = match.actionConfig?.product_ids;
    let query = supabase.from('wb_products').select('*').eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false });
    if (Array.isArray(productIds) && productIds.length) query = query.in('id', productIds);
    const { data: products } = await query;
    if (!products?.length) {
      console.error('[webhook] ecom_catalog rule fired but merchant has no active products');
      return;
    }

    const { data: settings } = await supabase.from('wb_ecom_settings').select('catalog_greeting').eq('user_id', userId).maybeSingle();
    // Messenger templates can't carry a caption the way a WhatsApp list body
    // can — send the greeting as its own text message first (see file 1's
    // buildCatalogGreetingMessage).
    await ecomChannelSender.sendRawMessengerPayload(userId, ecomMessages.buildCatalogGreetingMessage(channel, from, settings?.catalog_greeting));
    const payload = ecomMessages.buildCatalogMessage(channel, from, products, settings?.catalog_greeting);
    await ecomChannelSender.sendRawMessengerPayload(userId, payload);
  } catch (err) {
    console.error(`[webhook] ecom_catalog rule failed (${channel}):`, err.message);
  }
}

async function handleIncomingMessage(value, msg) {
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const { data: waAccount } = await supabase
    .from('wa_accounts')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .single();
  if (!waAccount) return;

  // Try to match the sender to a saved name so the Received tab can show
  // one. Uses wb_known_contacts (persistent) rather than wb_contacts
  // (a campaign audience list that gets fully wiped and replaced every
  // time a new contact list is uploaded, or once a campaign completes).
  let contactName = '';
  try {
    const { data: contact } = await supabase
      .from('wb_known_contacts')
      .select('name')
      .eq('user_id', waAccount.user_id)
      .eq('phone', msg.from)
      .single();
    if (contact?.name) contactName = contact.name;
  } catch (_) { /* no matching contact, that's fine */ }

  const { message_type, message_body } = extractMessagePreview(msg);

  // Store the inbound message so it shows up in the Received tab.
  // Voice notes / audio also keep Meta's media id so the audio can be
  // streamed on demand (see GET /api/messages/received/:id/media). If the
  // media_* columns haven't been migrated yet, retry without them so the
  // message itself is never lost.
  try {
    const inboundRow = {
      user_id: waAccount.user_id,
      wa_account_id: waAccount.id,
      phone: msg.from,
      contact_name: contactName,
      message_type,
      message_body,
      wa_message_id: msg.id || null,
      created_at: new Date().toISOString()
    };
    const hasAudio = msg.type === 'audio' && msg.audio?.id;
    let { error: insErr } = await supabase.from('wb_inbound_messages').insert(
      hasAudio
        ? { ...inboundRow, media_id: msg.audio.id, media_mime: msg.audio.mime_type || null, is_voice: !!msg.audio.voice }
        : inboundRow
    );
    if (insErr && hasAudio) {
      console.error('[webhook] insert with media fields failed, retrying without:', insErr.message);
      ({ error: insErr } = await supabase.from('wb_inbound_messages').insert(inboundRow));
    }
    if (insErr) console.error('[webhook] failed to store inbound message:', insErr.message);
  } catch (e) {
    console.error('[webhook] failed to store inbound message:', e.message);
  }

  // Nudge any registered Android devices for this user. Fire-and-forget —
  // a push failure shouldn't block or fail webhook processing, and the
  // 30s poll in mobile.html is still there as a fallback either way.
  sendNewMessagePush(supabase, waAccount.user_id, {
    phone: msg.from,
    contactName,
    body: message_body
  }).catch(e => console.error('[webhook] push notification failed:', e.message));

  // Ecom flow buttons ("Add to cart", "Checkout", "View Cart", "Clear cart")
  // are handled directly, before bot-engine's keyword rules even run — a
  // button tap is an explicit action, not something a keyword match should
  // intercept or override.
  const ecomReplyId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
  if (ecomReplyId && ecomReplyId.startsWith('ecom_')) {
    try {
      await handleEcomInteraction({ channel: 'whatsapp', userId: waAccount.user_id, from: msg.from, contactName, replyId: ecomReplyId, waAccount });
    } catch (err) {
      console.error('[webhook] ecom interaction failed:', err.message);
    }
    return;
  }

  // Chatbot-builder rules (src/routes/bot-engine.js) run before the generic
  // dashboard auto-reply below. This engine was previously fully built but
  // never actually invoked from here — it only existed as an "integration
  // note" comment at the bottom of bot-engine.js — which is why bot-builder
  // rules silently never fired even though the dashboard's own auto-reply
  // toggle worked fine.
  if (msg.type === 'text' && msg.text?.body) {
    let match = null;
    try {
      match = await matchRule({ supabase, getValidGoogleAccessToken }, {
        userId: waAccount.user_id,
        phone: msg.from,
        text: msg.text.body,
        replyOptionId: msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id
      });
    } catch (err) {
      console.error('[webhook] bot-engine matchRule failed:', err.message);
    }

    if (match) {
      if (match.actionType === 'template' && match.templateId) {
        try {
          const { data: tpl } = await supabase
            .from('wb_bot_templates').select('type, payload').eq('id', match.templateId).single();
          if (tpl) {
            // wb_bot_templates.payload is saved in a flat, non-Graph-API shape
            // by chatbot-builder.html — spreading it straight into the send
            // body (as this used to do) is exactly what Meta was rejecting
            // with "(#100) Invalid parameter". Convert it to a real payload first.
            //
            // If the rule has a sheet_lookup configured, let its result fill in
            // a {{sheet_lookup}} placeholder anywhere in the template's text
            // fields (body/header/footer/button titles/etc) before validation —
            // done via a stringify/replace/parse round-trip so it works no matter
            // which template type (plaintext/buttons/list/cta/product) is in play,
            // without hardcoding every possible field path.
            let templatePayload = tpl.payload;
            if (match.sheetLookupResult) {
              const value = match.sheetLookupResult.found ? String(match.sheetLookupResult.value) : '';
              const escaped = JSON.stringify(value).slice(1, -1); // escaped for safe re-embedding, no surrounding quotes
              try {
                templatePayload = JSON.parse(JSON.stringify(tpl.payload).split('{{sheet_lookup}}').join(escaped));
              } catch (e) {
                console.error('[webhook] sheet_lookup placeholder substitution failed:', e.message);
              }
            }
            let payload;
            try {
              payload = buildBotBuilderTemplatePayload(tpl.type, templatePayload, msg.from);
            } catch (convErr) {
              console.error('[webhook] bot-engine template payload invalid:', convErr.message);
              return;
            }
            const plainToken = decryptToken(waAccount.access_token);
            const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
              body: JSON.stringify(payload)
            });
            const responseData = await result.json().catch(() => ({}));
            if (result.ok) {
              const { message_type, message_body } = extractOutboundPreview(payload);
              logOutboundMessage({
                userId: waAccount.user_id, waAccountId: waAccount.id, phone: msg.from,
                contactName, messageType: message_type, messageBody: message_body,
                waMessageId: responseData?.messages?.[0]?.id || null, source: 'bot_builder'
              });
            } else {
              console.error('[webhook] bot-engine template send failed:', responseData?.error?.message || result.status);
            }
          }
        } catch (err) {
          console.error('[webhook] bot-engine template send failed:', err.message);
        }
      } else if (match.actionType === 'ai') {
        try {
          let systemPrompt = match.aiPrompt || 'You are a helpful business assistant.';
          if (match.docContent) {
            systemPrompt += `\n\nUse the following knowledge base content to answer questions:\n${match.docContent}`;
          }
          if (match.sheetLookupResult) {
            systemPrompt += match.sheetLookupResult.found
              ? `\n\nSheet lookup result for this message: "${match.sheetLookupResult.value}". Use this as the answer if it's relevant, in your own words.`
              : `\n\nA sheet lookup was attempted for this message but found no matching row. Say you don't have that information rather than guessing, and offer to connect the customer with a teammate.`;
          }
          const replyText = await generateReply({
            model: DEFAULT_AI_MODEL,
            systemPrompt,
            userText: msg.text.body
          }).catch(() => match.aiFallback);
          if (replyText) {
            const plainToken = decryptToken(waAccount.access_token);
            const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
              body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.from, type: 'text', text: { body: replyText } })
            });
            const responseData = await result.json().catch(() => ({}));
            if (result.ok) {
              logOutboundMessage({
                userId: waAccount.user_id, waAccountId: waAccount.id, phone: msg.from,
                contactName, messageType: 'text', messageBody: replyText,
                waMessageId: responseData?.messages?.[0]?.id || null, source: 'bot_builder'
              });
            } else {
              console.error('[webhook] bot-engine AI send failed:', responseData?.error?.message || result.status);
            }
          }
        } catch (err) {
          console.error('[webhook] bot-engine AI reply failed:', err.message);
        }
      } else if (match.actionType === 'ecom_catalog') {
        try {
          const ruleChannels = match.actionConfig?.channels;
          if (Array.isArray(ruleChannels) && ruleChannels.length && !ruleChannels.includes('whatsapp')) return;

          const productIds = match.actionConfig?.product_ids;
          let query = supabase.from('wb_products').select('*').eq('user_id', waAccount.user_id).eq('is_active', true).order('created_at', { ascending: false });
          if (Array.isArray(productIds) && productIds.length) query = query.in('id', productIds);
          const { data: products } = await query;

          const { data: settings } = await supabase.from('wb_ecom_settings').select('catalog_greeting').eq('user_id', waAccount.user_id).maybeSingle();

          if (!products?.length) {
            console.error('[webhook] ecom_catalog rule fired but merchant has no active products');
            return;
          }
          const payload = ecomMessages.buildCatalogMessage('whatsapp', msg.from, products, settings?.catalog_greeting);
          const plainToken = decryptToken(waAccount.access_token);
          const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
            body: JSON.stringify(payload)
          });
          const responseData = await result.json().catch(() => ({}));
          if (result.ok) {
            const { message_type, message_body } = extractOutboundPreview(payload);
            logOutboundMessage({
              userId: waAccount.user_id, waAccountId: waAccount.id, phone: msg.from,
              contactName, messageType: message_type, messageBody: message_body,
              waMessageId: responseData?.messages?.[0]?.id || null, source: 'bot_builder'
            });
          } else {
            console.error('[webhook] ecom_catalog send failed:', responseData?.error?.message || result.status);
          }
        } catch (err) {
          console.error('[webhook] ecom_catalog rule failed:', err.message);
        }
      }
      return; // a bot-builder rule handled this — skip the generic auto_reply settings below
    }
  }

  // Only plain text messages trigger the AI auto-reply.
  if (msg.type !== 'text' || !msg.text?.body) return;

  const { data: settings } = await supabase
    .from('wb_settings')
    .select('auto_reply, auto_reply_prompt, auto_reply_model, auto_reply_mode, auto_reply_template_id')
    .eq('user_id', waAccount.user_id)
    .single();
  if (!settings?.auto_reply) return;

  // Template mode: send a fixed interactive/text template as-is, no AI call.
  // Falls back to the AI flow below if no template is actually selected,
  // so flipping the mode toggle without picking a template doesn't go silent.
  if (settings.auto_reply_mode === 'template' && settings.auto_reply_template_id) {
    try {
      const { data: tpl, error: tplErr } = await supabase
        .from('wb_interactive_templates')
        .select('kind, config')
        .eq('id', settings.auto_reply_template_id)
        .eq('user_id', waAccount.user_id)
        .single();
      if (tplErr || !tpl) {
        console.error('[webhook] auto-reply template not found, falling back to no reply');
        return;
      }
      const vars = { name: contactName || msg.from, phone: msg.from };
      const payload = buildMessagePayload(tpl.kind, tpl.config, msg.from, vars);

      const plainToken = decryptToken(waAccount.access_token);
      const result = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
          body: JSON.stringify(payload),
        }
      );
      const responseData = await result.json().catch(() => ({}));
      if (result.ok) {
        const { message_type, message_body } = extractOutboundPreview(payload);
        logOutboundMessage({
          userId: waAccount.user_id, waAccountId: waAccount.id, phone: msg.from,
          contactName, messageType: message_type, messageBody: message_body,
          waMessageId: responseData?.messages?.[0]?.id || null, source: 'template_auto_reply'
        });
      } else {
        console.error('[webhook] template auto-reply failed:', responseData?.error?.message || result.status);
      }
    } catch (err) {
      console.error('[webhook] template auto-reply failed:', err.message);
    }
    return;
  }

  let replyText;
  try {
    replyText = await generateReply({
      model: settings.auto_reply_model || DEFAULT_AI_MODEL,
      systemPrompt: settings.auto_reply_prompt || 'You are a helpful business assistant.',
      userText: msg.text.body,
    });
  } catch (err) {
    console.error('[webhook] AI generation failed:', err.message);
    return;
  }
  if (!replyText) return;

  try {
    const plainToken = decryptToken(waAccount.access_token);
    const result = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: msg.from,
          type: 'text',
          text: { body: replyText },
        }),
      }
    );
    const responseData = await result.json().catch(() => ({}));
    if (result.ok) {
      logOutboundMessage({
        userId: waAccount.user_id, waAccountId: waAccount.id, phone: msg.from,
        contactName, messageType: 'text', messageBody: replyText,
        waMessageId: responseData?.messages?.[0]?.id || null, source: 'ai_auto_reply'
      });
    } else {
      console.error('[webhook] failed to send auto-reply:', responseData?.error?.message || result.status);
    }
  } catch (err) {
    console.error('[webhook] failed to send auto-reply:', err.message);
  }
}

// ================================================================
// 14. QUEUE PROCESSOR (Native — runs every 3 seconds)
// ================================================================
async function processQueue() {
  try {
    const nowIso = new Date().toISOString();
    const { data: dueCampaigns } = await supabase
      .from('wb_campaigns')
      .select('id, user_id')
      .eq('status', 'scheduled')
      .lte('schedule_at', nowIso);

    if (dueCampaigns?.length) {
      for (const item of dueCampaigns) {
        const { data: active } = await supabase
          .from('wb_campaigns')
          .select('id')
          .eq('user_id', item.user_id)
          .in('status', ['queued', 'running', 'paused'])
          .limit(1)
          .single();
        if (!active) {
          await supabase
            .from('wb_campaigns')
            .update({ status: 'running', updated_at: nowIso })
            .eq('id', item.id);
        }
      }
    }

    const { data: runningCampaigns } = await supabase
      .from('wb_campaigns')
      .select('id, user_id')
      .eq('status', 'running');

    if (!runningCampaigns?.length) {
      const { data: queuedCampaigns } = await supabase
        .from('wb_campaigns')
        .select('id, user_id')
        .eq('status', 'queued')
        .order('created_at', { ascending: true });

      if (queuedCampaigns?.length) {
        for (const item of queuedCampaigns) {
          const { data: active } = await supabase
            .from('wb_campaigns')
            .select('id')
            .eq('user_id', item.user_id)
            .in('status', ['running', 'paused'])
            .limit(1)
            .single();
          if (!active) {
            await supabase
              .from('wb_campaigns')
              .update({ status: 'running', updated_at: nowIso })
              .eq('id', item.id);
            runningCampaigns.push(item);
            break;
          }
        }
      }
    }

    if (!runningCampaigns?.length) return { processed: 0 };

    const runningIds = runningCampaigns.map(c => c.id);

    // A row left in 'processing' (server restarted / crashed between claiming
    // it and recording the result) would otherwise block the campaign forever.
    await recoverStaleQueueItems(runningIds);

    // Finish any running campaign that has nothing left to send. This is what
    // un-sticks a campaign whose last row was already sent but whose counters
    // never reached the total (so it sat on "running" at N-1/N indefinitely).
    for (const id of runningIds) {
      const { count: outstanding, error: outErr } = await supabase
        .from('wb_send_queue')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', id)
        .in('status', ['pending', 'processing']);
      if (!outErr && (outstanding || 0) === 0) await updateCampaignProgress(id);
    }

    // Get one pending queue item
    const { data: pending } = await supabase
      .from('wb_send_queue')
      .select('*')
      .eq('status', 'pending')
      .in('campaign_id', runningIds)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!pending?.length) return { processed: 0 };

    const queueItem = pending[0];

    // Load user settings for gap
    const { data: settings } = await supabase
      .from('wb_settings')
      .select('min_gap, max_gap')
      .eq('user_id', queueItem.user_id)
      .single();
    const minGap = settings?.min_gap || 5;
    const maxGap = settings?.max_gap || 15;
    const randomGap = minGap + Math.random() * (maxGap - minGap);

    // Check last sent time
    const { data: lastSent } = await supabase
      .from('wb_send_queue')
      .select('sent_at')
      .eq('campaign_id', queueItem.campaign_id)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();

    if (lastSent?.sent_at) {
      const secondsSinceLast = (Date.now() - new Date(lastSent.sent_at).getTime()) / 1000;
      if (secondsSinceLast < randomGap) {
        return { processed: 0, action: 'gap_wait', wait_seconds: Math.ceil(randomGap - secondsSinceLast) };
      }
    }

    // Get WA account
    const { data: waAccounts } = await supabase
      .from('wa_accounts')
      .select('*')
      .eq('user_id', queueItem.user_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (!waAccounts?.length) {
      await supabase
        .from('wb_send_queue')
        .update({ status: 'failed', error_reason: 'No WhatsApp account connected', processed_at: new Date().toISOString() })
        .eq('id', queueItem.id);
      await recordCampaignLog({
        campaign_id: queueItem.campaign_id, queue_id: queueItem.id, wa_message_id: null,
        delivery_status: 'failed', phone: queueItem.phone, contact_name: queueItem.contact_name || '',
        template_name: queueItem.template_name, message_body: '', error_reason: 'No WhatsApp account connected'
      });
      await updateCampaignProgress(queueItem.campaign_id);
      return { processed: 1, failed: 1 };
    }

    const waAccount = waAccounts[0];

    // Claim the row atomically: only one worker can flip pending -> processing.
    // (Two overlapping runs, e.g. during a zero-downtime deploy, used to both
    // pick the same row and send the contact two messages.)
    const { data: claimed, error: claimErr } = await supabase
      .from('wb_send_queue')
      .update({ status: 'processing', processed_at: new Date().toISOString() })
      .eq('id', queueItem.id)
      .eq('status', 'pending')
      .select('id');
    if (claimErr) {
      console.error('[queue] failed to claim queue item', queueItem.id, claimErr.message);
      return { processed: 0, error: claimErr.message };
    }
    if (!claimed?.length) return { processed: 0, action: 'claim_lost' };

    // Fetch campaign placeholder mapping for this queue item.
    // placeholder_mapping is free-form JSON: { "<key>": { type, value? } }
    // <key> can be a number ("1","2",...) for positional {{1}} {{2}} templates,
    // or a string ("a","b",...) for named {{a}} {{b}} templates — any number of
    // keys is supported, they're just iterated below.
    const { data: campaignData } = await supabase
      .from('wb_campaigns')
      .select('placeholder_mapping')
      .eq('id', queueItem.campaign_id)
      .single();

    let templatePayload = { name: queueItem.template_name, language: { code: queueItem.template_language || 'en_US' } };
    let bodyParams = [];
    if (campaignData?.placeholder_mapping && typeof campaignData.placeholder_mapping === 'object') {
      const resolveValue = (map) => {
        if (map.type === 'phone') return queueItem.phone || '';
        if (map.type === 'name') return queueItem.contact_name || '';
        if (map.type === 'message') return queueItem.contact_message || '';
        if (map.type === 'field') return queueItem.custom_fields_data?.[map.field] || '';
        if (map.type === 'custom') return map.value || '';
        return '';
      };

      const entries = Object.entries(campaignData.placeholder_mapping);
      const isPositional = entries.every(([key]) => /^\d+$/.test(key));

      let params;
      if (isPositional) {
        // {{1}}, {{2}}, ... — order matters, no parameter_name needed
        params = entries
          .map(([key, map]) => ({ position: parseInt(key, 10), text: resolveValue(map) }))
          .sort((a, b) => a.position - b.position)
          .map(({ text }) => ({ type: 'text', text }));
      } else {
        // {{a}}, {{b}}, ... — each parameter must carry its name
        params = entries.map(([key, map]) => ({
          type: 'text',
          parameter_name: key,
          text: resolveValue(map)
        }));
      }

      if (params.length) {
        templatePayload.components = [ { type: 'BODY', parameters: params } ];
        bodyParams = params;
      }
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: queueItem.phone,
      type: 'template',
      template: templatePayload
    };

    let sendSuccess = false;
    let waMessageId = null;
    let waId = null;
    let errorMsg = null;

    try {
      const plainToken = decryptToken(waAccount.access_token);
      const result = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
          body: JSON.stringify(payload)
        }
      );
      const responseData = await result.json();
      if (result.ok && responseData.messages?.[0]?.id) {
        waMessageId = responseData.messages[0].id;
        // Meta's canonical id for the recipient (country code included). Stored
        // so replies can be matched back to this campaign exactly.
        waId = responseData.contacts?.[0]?.wa_id || null;
        sendSuccess = true;
      } else {
        errorMsg = responseData.error?.message || `Meta API ${result.status}`;
      }
    } catch (err) {
      errorMsg = err.message;
    }

    // The exact text this recipient received (template body with their values
    // filled in). Stored on the queue row, the campaign log and the outbound
    // message thread.
    let messageBody = '';
    try {
      const tpl = await getTemplateForSend(queueItem.user_id, queueItem.template_name);
      messageBody = renderTemplateText(tpl, bodyParams) || `[Template: ${queueItem.template_name}]`;
    } catch (e) {
      messageBody = `[Template: ${queueItem.template_name}]`;
    }

    // Update queue item. If this fails silently, the item would stay in
    // 'processing' and (after the stale timeout) be marked failed even though
    // the delivery actually succeeded — so retry once, and fall back to the
    // pre-migration columns if message_body / wa_id don't exist yet.
    const queueUpdate = {
      status: sendSuccess ? 'sent' : 'failed',
      wa_message_id: waMessageId,
      error_reason: errorMsg,
      sent_at: sendSuccess ? new Date().toISOString() : null,
      attempt_count: (queueItem.attempt_count || 0) + 1
    };
    const queueUpdateFull = { ...queueUpdate, message_body: messageBody, wa_id: waId };
    let queueUpdateErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let { error } = await supabase.from('wb_send_queue').update(queueUpdateFull).eq('id', queueItem.id);
      if (error && isMissingColumnError(error)) {
        warnMigrationOnce('wb_send_queue.message_body/wa_id');
        ({ error } = await supabase.from('wb_send_queue').update(queueUpdate).eq('id', queueItem.id));
      }
      queueUpdateErr = error;
      if (!error) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (queueUpdateErr) {
      console.error('[queue] failed to update queue item after send', queueItem.id, queueUpdateErr);
    }

    // One log row per recipient — successes AND failures (previously only
    // successes were logged, so failed sends left no trace in the log table).
    await recordCampaignLog({
      campaign_id: queueItem.campaign_id,
      queue_id: queueItem.id,
      wa_message_id: waMessageId,
      delivery_status: sendSuccess ? 'sent' : 'failed',
      phone: queueItem.phone,
      contact_name: queueItem.contact_name || '',
      template_name: queueItem.template_name,
      message_body: messageBody,
      error_reason: errorMsg,
      sent_at: sendSuccess ? new Date().toISOString() : null
    });

    if (sendSuccess) {
      // Show it in the conversation thread too (fire-and-forget).
      logOutboundMessage({
        userId: queueItem.user_id, waAccountId: waAccount.id, phone: queueItem.phone,
        contactName: queueItem.contact_name || '', messageType: 'template',
        messageBody, waMessageId, source: 'campaign', campaignId: queueItem.campaign_id
      });
    }

    await updateCampaignProgress(queueItem.campaign_id);
    return { processed: 1, sent: sendSuccess ? 1 : 0, failed: sendSuccess ? 0 : 1, phone: queueItem.phone };
  } catch (err) {
    console.error('[queue] processor error:', err.message);
    return { processed: 0, error: err.message };
  }
}

// ---- Campaign queue helpers ----------------------------------------------

// Live counts for one campaign, straight from wb_send_queue.
async function getQueueCounts(campaignId) {
  const countBy = async (statuses) => {
    const { count, error } = await supabase
      .from('wb_send_queue')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('status', statuses);
    if (error) throw new Error(error.message);
    return count || 0;
  };
  const [sent, failed, outstanding] = await Promise.all([
    countBy(['sent']), countBy(['failed']), countBy(['pending', 'processing'])
  ]);
  return { sent, failed, outstanding, total: sent + failed + outstanding };
}

// Progress is RECOMPUTED from the queue rather than incremented. The old
// read-modify-write (+1 on a counter) lost an increment whenever a send landed
// while the campaign was paused/stopped (it returned early without counting),
// or whenever the counter update itself failed — leaving the campaign at N-1
// with nothing pending, so it never reached "completed". Recounting is
// idempotent: calling it any number of times always yields the right numbers.
async function updateCampaignProgress(campaignId) {
  try {
    const counts = await getQueueCounts(campaignId);
    const { data: campaign, error: fetchErr } = await supabase
      .from('wb_campaigns')
      .select('status')
      .eq('id', campaignId)
      .single();
    if (fetchErr || !campaign) {
      console.error('[updateCampaignProgress] failed to fetch campaign', campaignId, fetchErr);
      return;
    }

    const now = new Date().toISOString();
    const update = {
      queue_processed: counts.sent,
      queue_failed: counts.failed,
      sent_count: counts.sent,
      failed_count: counts.failed,
      updated_at: now
    };
    if (counts.total > 0) update.queue_total = counts.total;
    // Only a running campaign auto-completes; paused/draft ones keep their state.
    if (campaign.status === 'running' && counts.outstanding === 0 && counts.total > 0) {
      update.status = 'completed';
      update.completed_at = now;
    }

    const { error: updateErr } = await supabase.from('wb_campaigns').update(update).eq('id', campaignId);
    if (updateErr) console.error('[updateCampaignProgress] failed to update campaign', campaignId, updateErr);
  } catch (err) {
    console.error('[updateCampaignProgress] failed for campaign', campaignId, err.message);
  }
}

// Rows stuck in 'processing' (claimed, then the server died before recording the
// result) are closed out as failed. They are NOT retried: the message may
// already have reached the recipient and a retry would send it twice.
const STALE_PROCESSING_MS = 2 * 60 * 1000;
async function recoverStaleQueueItems(campaignIds) {
  try {
    const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const { data: stale, error } = await supabase
      .from('wb_send_queue')
      .select('id, campaign_id, phone, contact_name, template_name')
      .eq('status', 'processing')
      .in('campaign_id', campaignIds)
      .lt('processed_at', cutoff);
    if (error || !stale?.length) return;
    const reason = 'Interrupted before the result was recorded (server restart?). Not retried to avoid sending twice — check the delivery status in WhatsApp.';
    for (const row of stale) {
      const { data: closed } = await supabase
        .from('wb_send_queue')
        .update({ status: 'failed', error_reason: reason })
        .eq('id', row.id)
        .eq('status', 'processing')
        .select('id');
      if (closed?.length) {
        console.warn('[queue] closed stale processing item', row.id);
        await recordCampaignLog({
          campaign_id: row.campaign_id, queue_id: row.id, wa_message_id: null,
          delivery_status: 'failed', phone: row.phone, contact_name: row.contact_name || '',
          template_name: row.template_name, message_body: '', error_reason: reason
        });
      }
    }
    for (const id of new Set(stale.map(r => r.campaign_id))) await updateCampaignProgress(id);
  } catch (err) {
    console.error('[queue] stale recovery failed:', err.message);
  }
}

// ---- Rendered message text -------------------------------------------------
const templateCache = new Map();
async function getTemplateForSend(userId, name) {
  const key = `${userId}|${name}`;
  const hit = templateCache.get(key);
  if (hit && Date.now() - hit.t < 60000) return hit.tpl;
  const { data } = await supabase
    .from('wb_templates')
    .select('name, body, header_type, header_text, footer')
    .eq('user_id', userId)
    .eq('name', name)
    .limit(1);
  const tpl = data?.[0] || null;
  templateCache.set(key, { tpl, t: Date.now() });
  return tpl;
}

// Fills {{1}} / {{name}} placeholders with the values actually sent to Meta, so
// the stored text is exactly what the recipient saw.
function renderTemplateText(tpl, bodyParams) {
  if (!tpl) return '';
  const positional = [];
  const named = {};
  for (const p of (bodyParams || [])) {
    if (p.parameter_name) named[p.parameter_name] = p.text;
    else positional.push(p.text);
  }
  const fill = (text) => String(text || '').replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, key) => {
    if (/^\d+$/.test(key)) {
      const v = positional[parseInt(key, 10) - 1];
      return v !== undefined ? v : m;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : m;
  });
  const parts = [];
  if (tpl.header_text && (!tpl.header_type || String(tpl.header_type).toUpperCase() === 'TEXT')) parts.push(fill(tpl.header_text));
  if (tpl.body) parts.push(fill(tpl.body));
  if (tpl.footer) parts.push(tpl.footer);
  return parts.join('\n\n');
}

// ---- Campaign log writes -----------------------------------------------------
// Deliberately NOT upsert(..., { onConflict }). ON CONFLICT only works when a
// unique constraint on exactly those columns exists, and otherwise fails with
// 42P10 ("no unique or exclusion constraint matching...") or 23505 (a
// different unique key such as queue_id was hit) — and the error was only
// logged, so no log row was ever saved. Update-then-insert works whatever
// unique keys the table has, and a lost race (23505) turns into an update.
function isMissingColumnError(e) {
  if (!e) return false;
  return e.code === 'PGRST204' || e.code === '42703' ||
    /could not find the '.*' column/i.test(e.message || '') ||
    /column .* does not exist/i.test(e.message || '');
}
const _migrationWarned = new Set();
function warnMigrationOnce(what) {
  if (_migrationWarned.has(what)) return;
  _migrationWarned.add(what);
  console.warn(`[db] ${what} is missing — run migrations/012_campaign_logs_and_scoped_inbox.sql. Falling back to the old columns.`);
}

const CAMPAIGN_LOG_LEGACY_COLS = ['campaign_id', 'queue_id', 'wa_message_id', 'delivery_status', 'error_reason', 'created_at', 'updated_at'];

async function recordCampaignLog(row) {
  try {
    const now = new Date().toISOString();
    const full = { ...row, created_at: now, updated_at: now };
    const write = async (payload) => {
      const matchCol = payload.wa_message_id ? 'wa_message_id' : 'queue_id';
      const matchVal = payload[matchCol];
      if (!matchVal) return { message: 'log row has neither wa_message_id nor queue_id' };
      // Never re-label an existing row as 'sent': the delivery webhook may have
      // already advanced it to delivered/read.
      const patch = { ...payload };
      delete patch.created_at;
      if (patch.delivery_status === 'sent') delete patch.delivery_status;

      const upd = await supabase.from('wb_campaign_logs').update(patch).eq(matchCol, matchVal).select();
      if (upd.error) return upd.error;
      if (upd.data?.length) return null;

      const ins = await supabase.from('wb_campaign_logs').insert(payload);
      if (!ins.error) return null;
      if (ins.error.code === '23505') {
        const retry = await supabase.from('wb_campaign_logs').update(patch).eq(matchCol, matchVal).select();
        if (!retry.error && retry.data?.length) return null;
      }
      return ins.error;
    };

    let err = await write(full);
    if (err && isMissingColumnError(err)) {
      warnMigrationOnce('wb_campaign_logs.phone/message_body/…');
      const legacy = {};
      for (const k of CAMPAIGN_LOG_LEGACY_COLS) if (full[k] !== undefined) legacy[k] = full[k];
      err = await write(legacy);
    }
    if (err) console.error('[queue] failed to write campaign log', row.queue_id, { code: err.code, message: err.message, details: err.details, hint: err.hint });
  } catch (e) {
    console.error('[queue] failed to write campaign log', row.queue_id, e.message);
  }
}

// Meta delivery webhook: sent -> delivered -> read (or failed). Only ever moves
// a message forward (webhooks can arrive out of order) and ignores messages that
// do not belong to a campaign (AI / bot / manual replies also get status
// callbacks — the old upsert created an orphan log row for every one of them).
const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3 };
async function applyDeliveryStatus(status) {
  const waMessageId = status?.id;
  if (!waMessageId) return;
  const newStatus = status.status;
  const now = new Date().toISOString();
  const errTitle = status.errors?.[0]?.title || status.errors?.[0]?.message || null;

  const { data: rows, error } = await supabase
    .from('wb_campaign_logs').select('*').eq('wa_message_id', waMessageId).limit(1);
  if (error) { console.error('[webhook] campaign log lookup failed:', error.message); return; }
  const existing = rows?.[0];

  if (!existing) {
    // The status callback can beat the send loop's own log write. If this id
    // belongs to a campaign queue row, create the log row now.
    const { data: q } = await supabase
      .from('wb_send_queue').select('*').eq('wa_message_id', waMessageId).limit(1);
    if (!q?.length) return;
    const item = q[0];
    await recordCampaignLog({
      campaign_id: item.campaign_id, queue_id: item.id, wa_message_id: waMessageId,
      delivery_status: newStatus, phone: item.phone, contact_name: item.contact_name || '',
      template_name: item.template_name, message_body: item.message_body || '',
      error_reason: newStatus === 'failed' ? errTitle : null,
      delivered_at: newStatus === 'delivered' || newStatus === 'read' ? now : null,
      read_at: newStatus === 'read' ? now : null
    });
    return;
  }

  const patch = { updated_at: now };
  if (newStatus === 'failed') {
    patch.delivery_status = 'failed';
    if (errTitle) patch.error_reason = errTitle;
  } else if ((DELIVERY_RANK[newStatus] || 0) > (DELIVERY_RANK[existing.delivery_status] || 0)) {
    patch.delivery_status = newStatus;
  }
  if ((newStatus === 'delivered' || newStatus === 'read') && !existing.delivered_at) patch.delivered_at = now;
  if (newStatus === 'read' && !existing.read_at) patch.read_at = now;

  const { error: updErr } = await supabase
    .from('wb_campaign_logs').update(patch).eq('wa_message_id', waMessageId);
  if (updErr) console.error('[webhook] failed to update delivery status', waMessageId, updErr.message);
}

// ================================================================
// 15. AI CHAT ROUTES (NVIDIA API)
// ================================================================
app.use('/api/ai', aiChatRouter);

// ================================================================
// 15b. CRM ROUTES (Leads, Sources/Integrations, Field Mapping,
// Automations, Meetings, AI Chatbot, Billing)
// ================================================================
const crmDeps = {
  supabase, verifyUser, encryptToken, decryptToken, fetch,
  META_API_VERSION, SELF_URL, generateReply,
};

// /api/leads — every route here needs a logged-in user, so verifyUser is
// applied once at the mount level (unlike the routers below, which have
// a couple of public/webhook routes mixed in and gate per-route instead).
app.use('/api/leads', verifyUser, leadsRouter(crmDeps));
app.use('/api/field-mappings', verifyUser, fieldMappingsRouter(crmDeps));
app.use('/api/automations', verifyUser, automationsRouter(crmDeps));
app.use('/api/flows', verifyUser, flowsRouter(crmDeps));

// These three mix authenticated dashboard routes with public callback/webhook
// routes (Google OAuth redirect, smbooking webhook, website chatbot widget) —
// each router applies verifyUser itself, per-route.
app.use('/api/integrations', integrationsRouter(crmDeps));
app.use('/api/oauth', flowsRouter(crmDeps)); // OAuth callbacks for flow builder
app.use('/api/meetings', meetingsRouter(crmDeps));
app.use('/api', chatbotRouter(crmDeps)); // exposes /api/chatbot-config, /api/chatbot/*
app.use('/api/billing', billingRouter(crmDeps));
// Public (no-auth) — read-only, and only exposes the fields ecom-pay.html
// needs to render/poll a checkout: no contact info, no merchant data.
// Registered before the verifyUser-gated /api/ecom mount below so it isn't
// swallowed by it.
//
// While status is still 'pending' and a provider checkout has actually been
// started, this also re-verifies directly with the provider on every poll
// (same on-demand check as the authenticated /api/ecom/orders/:id/status
// route) rather than only reflecting whatever the webhook already wrote —
// so a customer sitting on ecom-pay.html gets a real fallback check even if
// the webhook is delayed or never arrives, without needing a login session.
app.get('/api/ecom/orders/:id/public', async (req, res) => {
  const { data: order, error } = await supabase.from('wb_orders')
    .select('id, user_id, channel, contact_id, amount, currency, status, provider, provider_order_id').eq('id', req.params.id).single();
  if (error || !order) return res.status(404).json({ error: 'Order not found' });

  let liveOrder = order;
  if (order.status === 'pending' && order.provider_order_id) {
    try {
      const status = await ecomPayments.verifyPayment({ order });
      if (status !== 'pending') {
        liveOrder = await ecomPayments.markOrderStatus(order.id, status);
      }
    } catch (err) {
      // Provider lookup failed (rate limit, transient error, etc.) — fall
      // back to the last-known DB status rather than failing the whole request.
      console.error(`Public order status check failed for order ${order.id}:`, err.message);
    }
  }

  const client_fields = liveOrder.provider === 'razorpay' && liveOrder.provider_order_id
    ? { razorpay_order_id: liveOrder.provider_order_id, razorpay_key_id: process.env.RAZORPAY_TEST_KEY_ID || process.env.RAZORPAY_KEY_ID }
    : {};
  res.json({
    order: { id: liveOrder.id, amount: liveOrder.amount, currency: liveOrder.currency, status: liveOrder.status, provider: liveOrder.provider, provider_order_id: liveOrder.provider_order_id },
    client_fields,
  });
});
app.use('/api/ecom', verifyUser, ecomRouter(crmDeps));
// Public — payment providers call this directly with no user session.
// The order id embedded in each provider's payload is how we find the merchant.
app.use('/api/payments/webhook', paymentsWebhookRouter(crmDeps));

// /api/sheet-watchers — CRUD for polling-based sheet automations (Sheet
// Reminders tab in the CRM). The actual polling loop is started separately
// below via startSheetPoller; this was previously coded but never mounted,
// so every request to it 404'd and the frontend tab always showed empty.
app.use('/api/sheet-watchers', verifyUser, sheetWatchersRouter(crmDeps));

// /api/bot-builder — Chatbot builder UI routes (rules & templates)
// Every route here needs a logged-in user, so verifyUser is applied at mount level.
app.use('/api/bot-builder', verifyUser, botBuilderRouter(crmDeps));

// Public lead-capture endpoints (Google Sheet Apps Script, generic form tools)
// and the authenticated "generate my webhook URL" endpoint that feeds them.
app.use('/api/hooks', webhooksInboundRouter(crmDeps));
app.use('/api/webhook-endpoints', webhooksInboundRouter.endpointsRouter(crmDeps));

// ================================================================
// SOCIAL MANAGER (sm/) — mounted under /sm, sharing the Supabase REST
// client (`supabase`, created above) instead of a raw pg pool. Public/
// webhook routes first, then session-gated ones, matching sm/server.js's
// original ordering.
// ================================================================
app.use('/sm', smcWebhooksRouter(supabase));
app.use('/sm/api/auth', smcAuthRouter(supabase));
app.use('/sm/api/connections', smcConnectionsRouter.oauthRouter(supabase));
app.use('/sm/api/media', smcMediaRouter.streamRouter(supabase));

app.use('/sm/api/connections', smcRequireAuth, smcConnectionsRouter(supabase));
app.use('/sm/api/posts', smcRequireAuth, smcPostsRouter(supabase));
app.use('/sm/api/automations', smcRequireAuth, smcAutomationsRouter(supabase));
app.use('/sm/api/comments', smcRequireAuth, smcCommentsRouter(supabase));
app.use('/sm/api/media', smcRequireAuth, smcMediaRouter.router(supabase));
app.use('/sm/api/insights', smcRequireAuth, smcInsightsRouter(supabase));
app.use('/sm/api/ai', smcAiRouter(supabase));

// Operator-only: manually (re)connect the shared owner Google Drive used
// for media storage. Gated by SM_DRIVE_ADMIN_SECRET inside the router
// itself, not by smcRequireAuth — this isn't a per-user route.
app.use('/sm/admin', smcAdminDriveRouter.pageRouter(supabase));
app.use('/sm/api/admin/drive', smcAdminDriveRouter.apiRouter(supabase));

app.use('/sm', express.static(path.join(__dirname, 'sm')));

// ================================================================
// CRM's Instagram/Facebook connect + unified inbox — reuses sm's own
// routers and tables (smc_connections, smc_automation_logs) rather than a
// second implementation. verifyUser resolves the CRM's Supabase Auth user;
// smcBridge.mapToSmcUser then swaps req.user for the linked smc_users
// identity (matched by email) before handing off to sm's unmodified
// handlers, which only ever look at req.user.id / req.user.sub.
// ================================================================
const smcBridge = require('./src/smc-bridge')(supabase);

// GET /api/social/connect-url/:platform -> { url } for the frontend to
// window.location.href to (mirrors the existing connectOAuth() pattern in
// crm.html, which already expects a JSON { url } response from a fetch
// call rather than a bare redirect, since this endpoint itself needs the
// Authorization header a plain top-level navigation wouldn't send).
app.get('/api/social/connect-url/:platform', verifyUser, async (req, res) => {
  const platform = req.params.platform;
  if (!['facebook', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }
  try {
    const smcUser = await smcBridge.getOrCreateSmcUser(req.user);
    const token = smcBridge.mintSmcToken(smcUser.id, smcUser.email);
    const url = `/sm/api/connections/${platform}/authorize?token=${encodeURIComponent(token)}&return_to=crm`;
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List/delete connections (GET /, DELETE /:id) — smcConnectionsRouter's
// protected CRUD router, unmodified, now reading/writing smc_connections
// for the CRM user's linked smc_users identity.
app.use('/api/social/connections', verifyUser, smcBridge.mapToSmcUser, smcConnectionsRouter(supabase));

// Unified inbox (GET /, GET /live, POST /:id/reply) — smcCommentsRouter,
// unmodified, reading/writing smc_automation_logs for the same identity.
app.use('/api/social/comments', verifyUser, smcBridge.mapToSmcUser, smcCommentsRouter(supabase));
app.get('/sm', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'index.html')));
app.get('/sm/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'dashboard.html')));
app.get('/sm/insights', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'insights.html')));
app.get('/sm/about', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'about.html')));
app.get('/sm/terms', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'terms.html')));
app.get('/sm/privacy-policy', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'privacy-policy.html')));
app.get('/sm/data-deletion', (req, res) => res.sendFile(path.join(__dirname, 'sm', 'data-deletion.html')));

// Background poller for wb_sheet_watchers (new-row auto-sends + recurring
// date reminders). Was previously written but never started — see
// src/sheet-poller.js for the tick logic.
startSheetPoller({
  supabase,
  fetch,
  sendChannelMessage: createChannelSender(crmDeps)
});

// Fallback for missed/delayed payment webhooks — see src/payment-poller.js.
startPaymentPoller(crmDeps);

// ================================================================
// 16. API KEY MANAGEMENT ROUTES
// (apiKeys module imported at top of file)
// ================================================================

// Get all API keys for current user
app.get('/api/api-keys', verifyUser, requireApiAccess, async (req, res) => {
  try {
    const keys = await apiKeys.listApiKeys(req.user.id);
    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new API key
app.post('/api/api-keys', verifyUser, requireApiAccess, async (req, res) => {
  const { name, permissions, rateLimits, scopedPhoneNumberId, description, expiresAt } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Key name is required' });
  }
  
  try {
    const result = await apiKeys.createApiKey({
      userId: req.user.id,
      name,
      permissions: permissions || {},
      rateLimits: rateLimits || { perMinute: 60, perHour: 1000, perDay: 10000 },
      scopedPhoneNumberId: scopedPhoneNumberId || null,
      description: description || null,
      expiresAt: expiresAt || null
    });
    
    res.json({ 
      success: true, 
      key: {
        id: result.id,
        name: result.name,
        keyPrefix: result.keyPrefix,
        apiKey: result.apiKey, // Only returned once!
        createdAt: result.createdAt
      },
      warning: 'Store this API key securely. It will not be shown again.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revoke an API key
app.delete('/api/api-keys/:id', verifyUser, requireApiAccess, async (req, res) => {
  try {
    const success = await apiKeys.revokeApiKey(req.params.id, req.user.id);
    if (success) {
      res.json({ success: true, message: 'API key revoked' });
    } else {
      res.status(404).json({ error: 'API key not found or already revoked' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// 17. START SERVER
// ================================================================
// Social Manager DB init + scheduler. Runs async so it doesn't block the
// listen() below (matches this app's existing non-blocking startup style).
// initSmcDB is now a no-op logger — smc_* schema is applied once via
// migrations/004_smclient_tables_with_prefix.sql, not at runtime, since the
// Supabase REST client has no DDL access (see sm/db/schema.js).
(async () => {
  try {
    await initSmcDB(supabase);
    console.log('✅ Social Manager (smc_*) tables ready');
    startSmcScheduler(supabase);
    console.log('✅ Social Manager scheduler started');
  } catch (err) {
    console.error('❌ Social Manager init failed:', err.message);
  }
})();

app.listen(PORT, () => {
  console.log(`✅ WaBlast server running on ${SELF_URL}`);
  console.log(`   PORT: ${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   DB: Supabase REST API (no pg driver)`);

  // Native Queue Processor — runs every 3 seconds
  let processorBusy = false;
  setTimeout(() => {
    setInterval(async () => {
      if (processorBusy) return;
      processorBusy = true;
      try {
        const data = await processQueue();
        if (data?.processed > 0) {
          console.log('[queue] processed:', { sent: data.sent, failed: data.failed, phone: data.phone });
        }
      } catch (err) {
        console.error('[queue] processor error:', err.message);
      } finally {
        processorBusy = false;
      }
    }, 3000);
  }, 5000);

  // Health check ping (every 14 min to keep Render awake)
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`);
      console.log('[health] ping sent');
    } catch (_) {}
  }, 14 * 60 * 1000);
});
function validateAndCoerce(reply) {
  if (reply.type === "button") {
    reply.buttons = reply.buttons.slice(0, 3).map(b => ({
      ...b,
      title: b.title.slice(0, 20)
    }));
    if (reply.buttons.length === 0) {
      return { type: "text", body: reply.body }; // graceful fallback
    }
  }
  if (reply.type === "list") {
    reply.sections.forEach(s => {
      s.title = s.title.slice(0, 24);
      s.rows = s.rows.slice(0, 10).map(r => ({
        ...r,
        title: r.title.slice(0, 24),
        description: r.description?.slice(0, 72)
      }));
    });
    // enforce total rows ≤10 across all sections
  }
  return reply;
}
