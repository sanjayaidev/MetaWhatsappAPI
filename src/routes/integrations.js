// src/routes/integrations.js — connect/disconnect lead-source & channel integrations.
const express = require('express');
const crypto = require('crypto');

module.exports = function integrationsRouter(deps) {
  const { supabase, encryptToken, verifyUser, fetch } = deps;
  const router = express.Router();

  const KNOWN_TYPES = ['google_sheet', 'web_form', 'instagram', 'facebook', 'smbooking', 'gmail'];

  // GET /api/integrations — list all connected/disconnected states for this user
  router.get('/', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_integrations').select('*').eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    const byType = new Map((data || []).map(i => [i.type, i]));
    const integrations = KNOWN_TYPES.map(type => byType.get(type) || { type, status: 'disconnected', config: {} });
    res.json({ integrations });
  });

  // POST /api/integrations/:type/connect
  router.post('/:type/connect', verifyUser, async (req, res) => {
    const { type } = req.params;
    if (!KNOWN_TYPES.includes(type)) return res.status(400).json({ error: `Unknown integration type: ${type}` });
    const config = req.body?.config || {};

    // Encrypt anything that looks like a secret before it touches the DB.
    const SENSITIVE_KEYS = ['access_token', 'api_key', 'webhook_secret', 'refresh_token'];
    const safeConfig = { ...config };
    for (const key of SENSITIVE_KEYS) {
      if (safeConfig[key]) safeConfig[key] = encryptToken(String(safeConfig[key]));
    }

    const { data, error } = await supabase.from('wb_integrations')
      .upsert({ user_id: req.user.id, type, config: safeConfig, status: 'connected', last_synced_at: new Date().toISOString() }, { onConflict: 'user_id,type' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ integration: data });
  });

  // POST /api/integrations/:type/disconnect
  router.post('/:type/disconnect', verifyUser, async (req, res) => {
    const { type } = req.params;
    const { data, error } = await supabase.from('wb_integrations')
      .update({ status: 'disconnected', config: {} })
      .eq('user_id', req.user.id).eq('type', type).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ integration: data });
  });

  // GET /api/integrations/gmail/oauth-url — builds the Google OAuth consent URL for Gmail send scope.
  router.get('/gmail/oauth-url', verifyUser, async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI; // e.g. https://yourapp.com/api/integrations/gmail/callback
    if (!clientId || !redirectUri) {
      return res.status(500).json({ error: 'Gmail OAuth is not configured (missing GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI env vars)' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    // Stash state -> user_id briefly so the callback can identify who authorized.
    await supabase.from('wb_integrations').upsert({
      user_id: req.user.id, type: 'gmail', status: 'pending', config: { oauth_state: state }
    }, { onConflict: 'user_id,type' });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/gmail.send',
      state
    });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  });

  // GET /api/integrations/gmail/callback — Google redirects here after consent.
  // NOTE: this route is intentionally NOT behind verifyUser (Google won't send your auth header) —
  // it's re-mounted publicly in server.js and identifies the user via `state`.
  router.get('/gmail/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.status(400).send(`Gmail connection failed: ${oauthError}`);
    if (!code || !state) return res.status(400).send('Missing code/state from Google');

    const { data: pending } = await supabase.from('wb_integrations').select('*').eq('type', 'gmail').contains('config', { oauth_state: state }).single();
    if (!pending) return res.status(400).send('Could not match this authorization to a pending connection — please retry from the dashboard.');

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenData.error_description || 'Token exchange failed');

      const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const profile = await profileRes.json();

      await supabase.from('wb_integrations').update({
        status: 'connected',
        config: {
          email: profile.emailAddress,
          access_token: encryptToken(tokenData.access_token),
          refresh_token: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : pending.config?.refresh_token
        },
        last_synced_at: new Date().toISOString()
      }).eq('id', pending.id);

      res.redirect('/crm.html?tab=sources&gmail=connected');
    } catch (err) {
      res.status(500).send(`Gmail connection failed: ${err.message}`);
    }
  });

  return router;
};
