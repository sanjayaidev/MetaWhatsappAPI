// sm/routes/admin-drive.js — operator-only page to manually (re)connect the
// shared owner Google Drive account used for media storage.
//
// Not tied to sm's per-user session/JWT auth (smcRequireAuth) at all — this
// is server-operator infrastructure, gated instead by a single shared
// secret in SM_DRIVE_ADMIN_SECRET, same pattern as server.js's existing
// verifyAdmin for /api/admin/create-user. Get a refresh token once (e.g. via
// Google's OAuth Playground using this app's own Client ID/Secret and the
// https://www.googleapis.com/auth/drive.file scope) and paste it in here —
// no automatic rotation, you come back and repeat this whenever Google
// invalidates it (unverified/Testing apps: refresh tokens expire after 7
// days of inactivity, so re-paste before then).
const express = require('express');
const ownerDriveToken = require('../lib/ownerDriveToken');

function requireAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.key || req.body?.key;
  if (!process.env.SM_DRIVE_ADMIN_SECRET || secret !== process.env.SM_DRIVE_ADMIN_SECRET) {
    return res.status(403).send('Forbidden: invalid or missing key');
  }
  next();
}

function renderPage(key) {
  const safeKey = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '');
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
    textarea { width: 100%; min-height: 80px; box-sizing: border-box; font-family: monospace; padding: 8px; }
    button { padding: 8px 16px; cursor: pointer; margin-top: 8px; }
    #result { margin-top: 12px; font-size: 14px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>Shared Google Drive connection</h1>
  <p>Backs media storage for every sm/ user. Paste a refresh token below to connect or reconnect it.</p>
  <div id="status">Checking status…</div>

  <label for="rt">Refresh token</label>
  <textarea id="rt" placeholder="1//0g...refresh token from Google OAuth"></textarea>
  <button onclick="save()">Save &amp; connect</button>
  <div id="result"></div>

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

// Mounted at /sm/admin — just the HTML page.
function pageRouter() {
  const r = express.Router();
  r.get('/drive', requireAdminSecret, (req, res) => {
    res.type('html').send(renderPage(req.query.key));
  });
  return r;
}

// Mounted at /sm/api/admin/drive — status + save endpoints the page calls.
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
