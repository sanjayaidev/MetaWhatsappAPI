const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { encrypt } = require('../lib/crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';
// Used to build absolute redirect_uri values that Meta/Google send users back to.
// Must exactly match a Valid OAuth Redirect URI configured in each app's dashboard.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const THREADS_VERSION = process.env.THREADS_VERSION || 'v1.0';

// Never send access_token back to the client, even to an authed admin —
// no legitimate UI need, and it shrinks the blast radius of any XSS.
const SAFE_FIELDS = 'id, platform, account_name, account_id, page_id, is_connected, token_expires_at, created_at, updated_at';

// Each platform gets its own App ID/Secret. Facebook and Instagram can share
// the same Meta app, but Threads requires separate registration. Google uses
// a single Google Cloud project for both Sheets and Drive.
const OAUTH_CONFIGS = {
  facebook: {
    label: 'Facebook',
    authUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    scope: 'pages_show_list,pages_read_engagement,pages_read_user_content,read_insights,business_management,pages_manage_metadata,pages_messaging,instagram_basic,instagram_manage_comments,instagram_manage_messages,marketing_messages_messenger,email',
    clientId: process.env.FB_APP_ID,
    clientSecret: process.env.FB_SECRET,
    webhookVerifyToken: process.env.FB_WEBHOOK_VERIFY_TOKEN,
  },
  instagram: {
    label: 'Instagram',
    authUrl: 'https://www.instagram.com/oauth/authorize',
    scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights',
    clientId: process.env.IG_APP_ID,
    clientSecret: process.env.IG_SECRET,
    webhookVerifyToken: process.env.IG_WEBHOOK_VERIFY_TOKEN,
  },
  threads: {
    label: 'Threads',
    authUrl: 'https://threads.net/oauth/authorize',
    scope: 'threads_basic,threads_content_publish,threads_manage_insights,threads_manage_replies,threads_read_replies,threads_delete',
    clientId: process.env.TH_APP_ID,
    clientSecret: process.env.TH_SECRET,
    webhookVerifyToken: process.env.TH_WEBHOOK_VERIFY_TOKEN,
  },
  linkedin: {
    label: 'LinkedIn',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    scope: 'openid profile w_member_social',
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
  },
  google_sheets: {
    label: 'Google Sheets',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },
  google_drive: {
    label: 'Google Drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  },
};

async function upsertConnection(pool, userId, { platform, account_name, account_id, page_id, access_token, token_expires_at }) {
  const encryptedToken = encrypt(access_token);
  const result = await pool.query(
    `INSERT INTO connections (user_id, platform, account_name, account_id, page_id, access_token, is_connected, token_expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, platform, account_id) DO UPDATE SET
       account_name=EXCLUDED.account_name, page_id=EXCLUDED.page_id,
       access_token=EXCLUDED.access_token, is_connected=true,
       token_expires_at=EXCLUDED.token_expires_at, updated_at=CURRENT_TIMESTAMP
     RETURNING ${SAFE_FIELDS}`,
    [userId, platform, account_name || null, account_id, page_id || null, encryptedToken, token_expires_at || null]
  );
  return result.rows[0];
}

// ===========================================================
// Facebook Login for Business + Page-linked IG
// (mirrors fb-login-test.js: pages_show_list -> instagram_basic)
// ===========================================================
// Note on "personal profile" posting: Meta's Graph API does not support
// publishing feed posts, comments, or messages to a personal profile for
// standard apps — that capability (the old `publish_actions` permission)
// was removed for public apps years ago. Everything this app can automate
// (posting, comment replies, DMs) has to go through a Facebook Page, so
// there is no personal-profile option to add here — only a choice of
// *which* Page, when the user manages more than one.
async function finishFacebook(pool, userId, code, redirectUri, config) {
  const tokenRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
    params: { client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, code },
  });
  const shortToken = tokenRes.data.access_token;

  const longRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      fb_exchange_token: shortToken,
    },
  });
  const userToken = longRes.data.access_token;
  const expiresAt = longRes.data.expires_in ? new Date(Date.now() + longRes.data.expires_in * 1000) : null;

  // pages_show_list — fetch ALL Pages this user manages, not just the first.
  const pagesRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`, {
    params: { fields: 'id,name,instagram_business_account,access_token', access_token: userToken },
  });
  const pages = pagesRes.data.data || [];
  if (!pages.length) throw new Error('No Facebook Pages found for this account — is it a Page admin?');

  if (pages.length > 1) {
    // Multiple Pages: don't silently guess which one the user wants — hand
    // back a selection token so the callback route can show a picker.
    return {
      needsPageSelection: true,
      selectionToken: jwt.sign(
        {
          sub: userId,
          platform: 'facebook',
          expiresAt,
          pages: pages.map(p => ({
            id: p.id,
            name: p.name,
            access_token: p.access_token,
            instagram_business_account: p.instagram_business_account || null,
          })),
        },
        JWT_SECRET,
        { expiresIn: '10m' }
      ),
      pages,
    };
  }

  return finishFacebookPage(pool, userId, pages[0], expiresAt);
}

// Completes the connection for a single, already-chosen Page (used both for
// the single-Page case above and for the picker's follow-up selection).
async function finishFacebookPage(pool, userId, page, expiresAt) {
  const fbConnection = await upsertConnection(pool, userId, {
    platform: 'facebook',
    account_name: page.name,
    account_id: page.id,
    page_id: page.id,
    access_token: page.access_token,
    token_expires_at: expiresAt,
  });

  // instagram_basic — auto-link the Page's connected IG business account, if any
  if (page.instagram_business_account) {
    const igId = page.instagram_business_account.id;
    const igRes = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${igId}`, {
      params: { fields: 'id,username', access_token: page.access_token },
    });
    await upsertConnection(pool, userId, {
      platform: 'instagram',
      account_name: `@${igRes.data.username}`,
      account_id: igId,
      page_id: page.id,
      access_token: page.access_token,
      token_expires_at: expiresAt,
    });
  }

  return fbConnection;
}

// ===========================================================
// Direct Instagram Login (graph.instagram.com)
// (mirrors ig-login-test.js: token exchange -> instagram_business_basic)
// ===========================================================
async function finishInstagram(pool, userId, code, redirectUri, config) {
  const tokenRes = await axios.post(
    'https://api.instagram.com/oauth/access_token',
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    })
  );
  const shortToken = tokenRes.data.access_token;

  const longRes = await axios.get('https://graph.instagram.com/access_token', {
    params: { grant_type: 'ig_exchange_token', client_secret: config.clientSecret, access_token: shortToken },
  });
  const longToken = longRes.data.access_token;
  const expiresAt = longRes.data.expires_in ? new Date(Date.now() + longRes.data.expires_in * 1000) : null;

  const meRes = await axios.get(`https://graph.instagram.com/${GRAPH_VERSION}/me`, {
    params: { fields: 'id,username,account_type', access_token: longToken },
  });

  return upsertConnection(pool, userId, {
    platform: 'instagram',
    account_name: `@${meRes.data.username}`,
    account_id: meRes.data.id,
    access_token: longToken,
    token_expires_at: expiresAt,
  });
}

// ===========================================================
// Threads Login
// (mirrors threads-login-test.js: token exchange -> threads_basic)
// ===========================================================
async function finishThreads(pool, userId, code, redirectUri, config) {
  const tokenRes = await axios.post(
    'https://graph.threads.net/oauth/access_token',
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    })
  );
  const shortToken = tokenRes.data.access_token;

  const longRes = await axios.get('https://graph.threads.net/access_token', {
    params: { grant_type: 'th_exchange_token', client_secret: config.clientSecret, access_token: shortToken },
  });
  const longToken = longRes.data.access_token;
  const expiresAt = longRes.data.expires_in ? new Date(Date.now() + longRes.data.expires_in * 1000) : null;

  const meRes = await axios.get(`https://graph.threads.net/${THREADS_VERSION}/me`, {
    params: { fields: 'id,username', access_token: longToken },
  });

  return upsertConnection(pool, userId, {
    platform: 'threads',
    account_name: `@${meRes.data.username}`,
    account_id: meRes.data.id,
    access_token: longToken,
    token_expires_at: expiresAt,
  });
}

// ===========================================================
// LinkedIn Login (Sign In with LinkedIn using OpenID Connect
// + Share on LinkedIn for w_member_social)
// Personal-profile only — no Company Page / Community Management access.
// ===========================================================
async function finishLinkedIn(pool, userId, code, redirectUri, config) {
  const tokenRes = await axios.post(
    'https://www.linkedin.com/oauth/v2/accessToken',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const accessToken = tokenRes.data.access_token;
  const expiresAt = tokenRes.data.expires_in ? new Date(Date.now() + tokenRes.data.expires_in * 1000) : null;

  const userinfoRes = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const sub = userinfoRes.data.sub; // LinkedIn member id — used to build the author URN when posting

  return upsertConnection(pool, userId, {
    platform: 'linkedin',
    account_name: userinfoRes.data.name || userinfoRes.data.email,
    account_id: sub,
    access_token: accessToken,
    token_expires_at: expiresAt,
  });
}

// ===========================================================
// Google Sheets / Google Drive
// Standard Google OAuth2 — no matching test script was provided for this
// one, so double-check scopes/endpoints against Google's current docs.
// ===========================================================
async function finishGoogle(pool, userId, code, redirectUri, config, platform) {
  const tokenRes = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
    })
  );
  const accessToken = tokenRes.data.access_token;
  const refreshToken = tokenRes.data.refresh_token;
  const expiresAt = tokenRes.data.expires_in ? new Date(Date.now() + tokenRes.data.expires_in * 1000) : null;

  const userinfoRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return upsertConnection(pool, userId, {
    platform,
    account_name: userinfoRes.data.email,
    account_id: userinfoRes.data.id,
    // Store the refresh token when Google gives us one so we can mint new
    // access tokens later; falls back to the (short-lived) access token
    // when Google doesn't issue a refresh token (e.g. repeat consent skipped).
    access_token: refreshToken || accessToken,
    token_expires_at: expiresAt,
  });
}

const FINISHERS = {
  facebook: finishFacebook,
  instagram: finishInstagram,
  threads: finishThreads,
  linkedin: finishLinkedIn,
  google_sheets: (pool, userId, code, redirectUri, config) => finishGoogle(pool, userId, code, redirectUri, config, 'google_sheets'),
  google_drive: (pool, userId, code, redirectUri, config) => finishGoogle(pool, userId, code, redirectUri, config, 'google_drive'),
};

// ===========================================================
// PUBLIC router: /authorize and /callback.
// Mounted WITHOUT requireAuth in server.js — Meta/Google redirect users
// here directly (no way for them to attach our Bearer token), so auth is
// resolved manually: session cookie, or a `token` query param for the
// initial /authorize hop; the callback trusts the signed `state` instead.
// ===========================================================
function oauthRouter(pool) {
  const r = express.Router();

  r.get('/:platform/authorize', (req, res) => {
    const platform = req.params.platform;
    const config = OAUTH_CONFIGS[platform];
    if (!config) return res.status(404).send('Unknown platform');
    if (!config.clientId || !config.clientSecret) {
      return res.status(500).send(`${config.label} isn't configured yet — set its App ID/Secret env vars on the server.`);
    }

    let userId = req.session && req.session.userId;
    if (!userId && req.query.token) {
      try { userId = jwt.verify(req.query.token, JWT_SECRET).sub; } catch { /* fall through to 401 below */ }
    }
    if (!userId) return res.status(401).send('Please log in first, then try connecting again.');

    const state = jwt.sign({ sub: userId, platform }, JWT_SECRET, { expiresIn: '10m' });
    const redirectUri = `${APP_BASE_URL}/api/connections/${platform}/callback`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: config.scope,
      response_type: 'code',
      state,
      ...(config.extraParams || {}),
    });
    res.redirect(`${config.authUrl}?${params.toString()}`);
  });

  r.get('/:platform/callback', async (req, res) => {
    const platform = req.params.platform;
    const config = OAUTH_CONFIGS[platform];
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.redirect(`/dashboard.html?conn_error=${encodeURIComponent(error_description || error)}`);
    }
    if (!config || !code || !state) {
      return res.redirect('/dashboard.html?conn_error=Missing+authorization+code');
    }

    let payload;
    try {
      payload = jwt.verify(state, JWT_SECRET);
    } catch {
      return res.redirect('/dashboard.html?conn_error=Login+session+expired%2C+please+try+again');
    }
    if (payload.platform !== platform) {
      return res.redirect('/dashboard.html?conn_error=State+mismatch');
    }

    const redirectUri = `${APP_BASE_URL}/api/connections/${platform}/callback`;
    try {
      const saved = await FINISHERS[platform](pool, payload.sub, code, redirectUri, config);
      if (saved && saved.needsPageSelection) {
        return res.send(renderPagePickerHtml(saved.pages, saved.selectionToken));
      }
      res.redirect(`/dashboard.html?connected=${encodeURIComponent(saved.platform)}`);
    } catch (err) {
      const message = err.response ? JSON.stringify(err.response.data) : err.message;
      res.redirect(`/dashboard.html?conn_error=${encodeURIComponent(message)}`);
    }
  });

  // Renders a minimal, dependency-free picker page — no separate frontend
  // build step needed for what's a one-time, rarely-seen interstitial.
  function renderPagePickerHtml(pages, selectionToken) {
    const options = pages.map(p =>
      `<button class="page-btn" data-id="${p.id}" style="display:block;width:100%;text-align:left;padding:14px 16px;margin:8px 0;border:1px solid #ddd;border-radius:8px;background:#fff;font:inherit;font-size:15px;cursor:pointer;">${(p.name || p.id).replace(/</g, '&lt;')}</button>`
    ).join('');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Choose a Facebook Page</title></head>
<body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">
  <h2>Which Page should this connect to?</h2>
  <p style="color:#666;">Your Facebook account manages more than one Page. Pick the one you want automations, posting, and comment/DM replies to use.</p>
  <div id="pageList">${options}</div>
  <p id="err" style="color:#c00;"></p>
  <script>
    document.getElementById('pageList').addEventListener('click', async (e) => {
      const btn = e.target.closest('.page-btn');
      if (!btn) return;
      document.querySelectorAll('.page-btn').forEach(b => b.disabled = true);
      try {
        const res = await fetch('/api/connections/facebook/select-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selectionToken: ${JSON.stringify(selectionToken)}, pageId: btn.dataset.id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not connect that Page');
        window.location = data.redirect;
      } catch (err) {
        document.getElementById('err').textContent = err.message;
        document.querySelectorAll('.page-btn').forEach(b => b.disabled = false);
      }
    });
  </script>
</body></html>`;
  }

  // Finalizes the connection once the user has picked a Page from the
  // picker above. Trusts the signed selectionToken (issued only right after
  // a real OAuth exchange) rather than re-hitting Graph, since it already
  // carries each Page's access_token from /me/accounts.
  r.post('/facebook/select-page', async (req, res) => {
    const { selectionToken, pageId } = req.body || {};
    if (!selectionToken || !pageId) {
      return res.status(400).json({ error: 'selectionToken and pageId are required' });
    }
    let payload;
    try {
      payload = jwt.verify(selectionToken, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'This selection has expired — please reconnect Facebook and try again.' });
    }
    const page = (payload.pages || []).find(p => String(p.id) === String(pageId));
    if (!page) {
      return res.status(400).json({ error: 'That Page was not part of the original selection.' });
    }
    try {
      const saved = await finishFacebookPage(pool, payload.sub, page, payload.expiresAt ? new Date(payload.expiresAt) : null);
      res.json({ redirect: `/dashboard.html?connected=${encodeURIComponent(saved.platform)}` });
    } catch (err) {
      res.status(500).json({ error: err.response ? JSON.stringify(err.response.data) : err.message });
    }
  });

  return r;
}

// ===========================================================
// PROTECTED router: plain CRUD over saved connections.
// Mounted behind requireAuth in server.js, same as before.
// ===========================================================
function router(pool) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const result = await pool.query(`SELECT ${SAFE_FIELDS} FROM connections WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { platform, account_name, account_id, page_id, access_token, token_expires_at } = req.body;
      if (!platform || !account_id || !access_token) {
        return res.status(400).json({ error: 'platform, account_id, and access_token are required' });
      }
      const result = await upsertConnection(pool, userId, { platform, account_name, account_id, page_id, access_token, token_expires_at });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      await pool.query('DELETE FROM connections WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
module.exports.router = router;
module.exports.oauthRouter = oauthRouter;
