// sm/routes/admin-drive.js — operator-only page to (re)connect the shared
// owner Google Drive account used for media storage.
//
// Not tied to sm's per-user session/JWT auth (smcRequireAuth) at all — this
// is server-operator infrastructure, gated instead by a single shared
// secret in SM_DRIVE_ADMIN_SECRET, same pattern as server.js's existing
// verifyAdmin for /api/admin/create-user.
//
// Two ways to connect, both landing on the same ownerDriveToken.setRefreshToken:
//   1. "Connect with Google" button — real OAuth flow (same Client ID/Secret
//      as sm's other Google connections), the normal/preferred path.
//   2. Manual paste box — for pasting a refresh token obtained elsewhere
//      (e.g. OAuth Playground), kept as a fallback for when a browser
//      redirect through this server isn't convenient.
// Either way this is a manual, operator-initiated action — no auto-rotation
// cron. Re-run whichever flow whenever Google invalidates the refresh token
// (unverified/Testing apps: it expires after 7 days of inactivity).
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const ownerDriveToken = require('../lib/ownerDriveToken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
const REDIRECT_URI = `${APP_BASE_URL}/sm/admin/drive/callback`;
// drive.file only (not full Drive scope) — matches what googleDrive.js
// actually needs, and what the removed per-user flow used to request.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function requireAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.key || req.body?.key;
  if (!process.env.SM_DRIVE_ADMIN_SECRET || secret !== process.env.SM_DRIVE_ADMIN_SECRET) {
    return res.status(403).send('Forbidden: invalid or missing key');
  }
  next();
}

function renderPage({ key, connected, error }) {
  const safeKey = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const banner = connected
    ? `<div class="banner ok">Connected via Google — refresh token saved.</div>`
    : error
    ? `<div class="banner err">${String(error).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Shared Google Drive — Admin</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 20px; }
    #status { padding: 12px 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; }
    #status.connected { background: #e6f6ec; color: #146c2e; }
    #status.disconnected { background: #fdecec; color: #9b1c1c; }
    .banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .banner.ok { background: #e6f6ec; color: #146c2e; }
    .banner.err { background: #fdecec; color: #9b1c1c; }
    .connect-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; background: #4285f4; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 500; }
    .connect-btn:hover { background: #3367d6; }
    hr { margin: 28px 0; border: none; border-top: 1px solid #e5e5e5; }
    details summary { cursor: pointer; color: #555; font-size: 14px; }
    textarea { width: 100%; min-height: 80px; box-sizing: border-box; font-family: monospace; padding: 8px; margin-top: 8px; }
    button { padding: 8px 16px; cursor: pointer; margin-top: 8px; }
    #result { margin-top: 12px; font-size: 14px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>Shared Google Drive connection</h1>
  <p>Backs media storage for every sm/ user.</p>
  ${banner}
  <div id="status">Checking status…</div>

  <p><a class="connect-btn" href="/sm/admin/drive/authorize?key=${encodeURIComponent(safeKey)}">Connect with Google</a></p>

  <hr>
  <details>
    <summary>Or paste a refresh token manually</summary>
    <label for="rt">Refresh token</label>
    <textarea id="rt" placeholder="1//0g...refresh token from Google OAuth"></textarea>
    <button onclick="save()">Save &amp; connect</button>
    <div id="result"></div>
  </details>

  <script>
    const KEY = ${JSON.stringify(safeKey)};

    async function refreshStatus() {
      const res = await fetch('/sm/api/admin/drive/status', { headers: { 'x-admin-secret': KEY } });
      const data = await res.json();
      const el = document.getElementById('status');
      if (data.connected) {
        el.className = 'connected';
        el.textContent = 'Connected — last updated ' + new Date(data.updatedAt).toLocaleString();
      } else {
        el.className = 'disconnected';
        el.textContent = 'Not connected';
      }
    }

    async function save() {
      const refresh_token = document.getElementById('rt').value.trim();
      const resultEl = document.getElementById('result');
      resultEl.textContent = 'Saving…';
      try {
        const res = await fetch('/sm/api/admin/drive/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-secret': KEY },
          body: JSON.stringify({ refresh_token }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        resultEl.textContent = 'Connected successfully.';
        document.getElementById('rt').value = '';
        refreshStatus();
      } catch (err) {
        resultEl.textContent = 'Error: ' + err.message;
      }
    }

    refreshStatus();
  </script>
</body>
</html>`;
}

// Mounted at /sm/admin — the page, the OAuth kickoff, and the OAuth callback.
function pageRouter(supabase) {
  const r = express.Router();

  r.get('/drive', requireAdminSecret, (req, res) => {
    res.type('html').send(renderPage({
      key: req.query.key,
      connected: req.query.connected === '1',
      error: req.query.error,
    }));
  });

  // Kicks off the real Google consent screen. access_type=offline +
  // prompt=consent guarantees a refresh_token comes back even if this
  // Google account consented to this app before.
  r.get('/drive/authorize', requireAdminSecret, (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).send('Google isn\u2019t configured on this server — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.');
    }
    // The admin key travels inside the signed state (Google's redirect back
    // won't carry our x-admin-secret header), so the callback can rebuild
    // the return URL without ever trusting an unsigned query param for auth.
    const state = jwt.sign({ key: req.query.key }, JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // Google redirects the browser here directly — no custom headers, so
  // auth is the signed state, not requireAdminSecret.
  r.get('/drive/callback', async (req, res) => {
    const { code, state, error: googleError } = req.query;
    let payload;
    try {
      payload = jwt.verify(state, JWT_SECRET);
    } catch {
      return res.status(400).send('Invalid or expired connect request — go back to /sm/admin/drive and try again.');
    }
    const key = payload.key;
    const back = (qs) => res.redirect(`/sm/admin/drive?key=${encodeURIComponent(key)}&${qs}`);

    if (googleError) return back(`error=${encodeURIComponent(googleError)}`);
    if (!code) return back('error=No authorization code returned by Google');

    try {
      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code,
      }));
      const refreshToken = tokenRes.data.refresh_token;
      if (!refreshToken) {
        return back('error=' + encodeURIComponent('Google did not return a refresh token — revoke this app\u2019s access at myaccount.google.com/permissions and try again.'));
      }
      await ownerDriveToken.setRefreshToken(supabase, refreshToken);
      return back('connected=1');
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      return back('error=' + encodeURIComponent(message));
    }
  });

  return r;
}

// Mounted at /sm/api/admin/drive — status + manual-save endpoints the page calls.
function apiRouter(supabase) {
  const r = express.Router();

  r.get('/status', requireAdminSecret, async (req, res) => {
    try {
      res.json(await ownerDriveToken.getStatus(supabase));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/token', requireAdminSecret, async (req, res) => {
    try {
      const { refresh_token } = req.body || {};
      if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });
      const result = await ownerDriveToken.setRefreshToken(supabase, refresh_token);
      res.json(result);
    } catch (err) {
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      res.status(400).json({ error: message });
    }
  });

  return r;
}

module.exports = { pageRouter, apiRouter };
