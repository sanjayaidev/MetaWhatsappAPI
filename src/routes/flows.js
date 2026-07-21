// src/routes/flows.js — Visual flow builder for multi-step automations
const express = require('express');
const crypto = require('crypto');

module.exports = function flowsRouter(deps) {
  const { supabase, encryptToken, decryptToken, verifyUser, fetch } = deps;
  const { getValidGoogleAccessToken } = require('../google-auth')(deps);
  const router = express.Router();

  // Postgrest/Supabase errors carry code/details/hint that error.message alone
  // drops (e.g. 42703 undefined column, 23502 not-null violation, 23503 FK
  // violation, 23505 unique violation). Log all of it server-side so a schema
  // mismatch is diagnosable from logs without reproducing the request.
  function logDbError(context, error) {
    if (!error) return;
    console.error(`[DB ERROR] ${context}:`, {
      message: error.message, code: error.code, details: error.details, hint: error.hint
    });
  }

  // Pages allowed as an OAuth return target, keyed by the short name the
  // frontend passes in ?return_to=. Whitelisted (rather than trusting an
  // arbitrary path) so the callback can't be used as an open redirect.
  const OAUTH_RETURN_PAGES = {
    crm: '/crm.html?tab=flows',
    'chatbot-builder': '/chatbot-builder.html?view=integrations'
  };

  // GET /api/flows — list all flows for user
  router.get('/', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_flows').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ flows: data || [] });
  });

  // GET /api/flows/:id — get single flow
  router.get('/:id', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_flows').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'Flow not found' });
    res.json({ flow: data });
  });

  // POST /api/flows — create new flow
  router.post('/', verifyUser, async (req, res) => {
    const { name = 'Untitled Flow', description = '', trigger_config = {}, nodes = [], edges = [], variables = {} } = req.body || {};
    const { data, error } = await supabase.from('wb_flows')
      .insert({ user_id: req.user.id, name, description, trigger_config, nodes, edges, variables })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ flow: data });
  });

  // PUT /api/flows/:id — update flow (nodes, edges, config)
  router.put('/:id', verifyUser, async (req, res) => {
    const patch = {};
    ['name', 'description', 'status', 'trigger_config', 'nodes', 'edges', 'variables'].forEach(k => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('wb_flows')
      .update(patch).eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ flow: data });
  });

  // DELETE /api/flows/:id — delete flow
  router.delete('/:id', verifyUser, async (req, res) => {
    const { error } = await supabase.from('wb_flows').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // POST /api/flows/:id/run — manually trigger a flow
  router.post('/:id/run', verifyUser, async (req, res) => {
    const { data: flow } = await supabase.from('wb_flows').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    // Create execution record
    const { data: execution, error: execError } = await supabase.from('wb_flow_executions')
      .insert({ flow_id: flow.id, user_id: req.user.id, trigger_data: req.body.trigger_data || {} })
      .select().single();
    if (execError) return res.status(500).json({ error: execError.message });

    res.json({ execution_id: execution.id, status: 'started' });
    // Fire and forget - actual execution happens async
    executeFlow(supabase, flow, execution.id, req.body.trigger_data || {}).catch(err => {
      console.error('[flow execution error]', err);
    });
  });

  // GET /api/flows/:id/executions — get execution history
  router.get('/:id/executions', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_flow_executions')
      .select('*').eq('flow_id', req.params.id).eq('user_id', req.user.id)
      .order('started_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ executions: data || [] });
  });

  // ── OAuth Connection Endpoints ───────────────────────────────────────

  // GET /api/oauth/:service/oauth-url — get OAuth authorization URL
  router.get('/:service/oauth-url', verifyUser, async (req, res) => {
    const { service } = req.params;
    const validServices = ['google', 'facebook', 'instagram'];
    if (!validServices.includes(service)) {
      return res.status(400).json({ error: `Unsupported service: ${service}` });
    }

    const state = crypto.randomBytes(16).toString('hex');
    console.log('[OAuth URL] Generating state:', state, 'for user:', req.user.id);

    // Which page should the callback bounce back to when this finishes?
    // Whitelisted against OAUTH_RETURN_PAGES — anything unrecognized falls
    // back to the CRM flows tab rather than trusting an arbitrary path.
    const returnToKey = OAUTH_RETURN_PAGES[req.query.return_to] ? req.query.return_to : 'crm';

    // Store pending state in its own dedicated column (unique-constrained).
    // NOTE: this upsert on (user_id, service) will overwrite any existing row for this
    // service, including a previously-connected token, if the user restarts the flow
    // before finishing it. Acceptable for now, but worth revisiting if that matters.
    // return_to rides in metadata (jsonb, no schema change needed) and is read
    // back by the callback below.
    const { error: upsertError } = await supabase.from('wb_oauth_tokens').upsert({
      user_id: req.user.id,
      service,
      token_type: 'oauth2',
      state,
      access_token_enc: null,
      metadata: { return_to: returnToKey }
    }, { onConflict: 'user_id,service' });

    if (upsertError) {
      logDbError('oauth-url upsert wb_oauth_tokens', upsertError);
      return res.status(500).json({ error: 'Failed to initiate OAuth' });
    }

    let authUrl;
    if (service === 'google') {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const baseUrl = (process.env.APP_URL || '').replace(/\/$/, ''); // Remove trailing slash
      const redirectUri = `${baseUrl}/api/oauth/google/callback`;
      if (!clientId || !redirectUri) {
        return res.status(500).json({ error: 'Google OAuth not configured' });
      }
      const params = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        access_type: 'offline', prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/spreadsheets.readonly', 
                'https://www.googleapis.com/auth/drive.metadata.readonly',
                'https://www.googleapis.com/auth/documents.readonly',
                'https://www.googleapis.com/auth/gmail.send',
                'https://www.googleapis.com/auth/userinfo.email'].join(' '),
        state
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } else if (service === 'facebook' || service === 'instagram') {
      const appId = process.env.FACEBOOK_APP_ID;
      const redirectUri = `${process.env.APP_URL || ''}/api/oauth/facebook/callback`;
      if (!appId || !redirectUri) {
        return res.status(500).json({ error: 'Facebook OAuth not configured' });
      }
      const scope = service === 'instagram' ? 'instagram_basic,pages_show_list,instagram_manage_messages' : 'pages_manage_metadata,pages_messaging';
      const params = new URLSearchParams({
        client_id: appId, redirect_uri: redirectUri, response_type: 'code',
        scope, state
      });
      authUrl = `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
    }

    res.json({ url: authUrl, state });
  });

  // GET /api/oauth/:service/callback — OAuth callback handler
  router.get('/:service/callback', async (req, res) => {
    const { service } = req.params;
    const { code, state, error: oauthError } = req.query;
    console.log('[OAuth Callback] service:', service, 'state:', state, 'code:', code ? 'present' : 'missing');
    if (oauthError) return res.status(400).send(`OAuth failed: ${oauthError}`);
    if (!code || !state) return res.status(400).send('Missing code/state');

    // Find pending connection — lookup on the dedicated, unique, indexed state column
    const { data: pending, error: lookupError } = await supabase.from('wb_oauth_tokens')
      .select('*').eq('service', service).eq('state', state).single();
    if (lookupError) logDbError('oauth callback lookup wb_oauth_tokens', lookupError);
    console.log('[OAuth Lookup] found:', !!pending, 'error:', lookupError?.message);
    if (!pending) return res.status(400).send('Could not match OAuth state');

    try {
      let tokenData, profileData;

      if (service === 'google') {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: `${(process.env.APP_URL || '').replace(/\/$/, '')}/api/oauth/google/callback`,
            grant_type: 'authorization_code'
          })
        });
        tokenData = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(tokenData.error_description || 'Token exchange failed');

        const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        profileData = await profileRes.json();
      } else if (service === 'facebook' || service === 'instagram') {
        const tokenRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${encodeURIComponent(process.env.APP_URL || '')}/api/oauth/facebook/callback&client_secret=${process.env.FACEBOOK_APP_SECRET}&code=${code}`);
        tokenData = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(tokenData.error_message || 'Token exchange failed');

        // Get page info
        const meRes = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenData.access_token}`);
        const pagesData = await meRes.json();
        profileData = { pages: pagesData.data || [] };
      }

      // Read back before this update overwrites metadata with the profile payload.
      const returnToKey = pending.metadata?.return_to;

      // Store tokens. Rotate `state` to a fresh unused value rather than nulling it,
      // since the column is NOT NULL and unique-constrained — this just invalidates
      // the consumed state so it can't be reused.
      const { error: updateError } = await supabase.from('wb_oauth_tokens').update({
        access_token_enc: encryptToken(tokenData.access_token),
        refresh_token_enc: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
        expires_at: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null,
        // Google's token response returns `scope` as a SPACE-delimited string,
        // not comma-delimited — splitting on ',' silently produced a single
        // one-element array, so every scope-membership check downstream
        // (e.g. "does this connection have Docs access?") was unreliable.
        scopes: tokenData.scope?.split(' ') || [],
        metadata: { email: profileData.email, ...profileData },
        state: crypto.randomBytes(16).toString('hex'),
        updated_at: new Date().toISOString()
      }).eq('id', pending.id);

      if (updateError) logDbError('oauth callback update wb_oauth_tokens', updateError);

      const returnPath = OAUTH_RETURN_PAGES[returnToKey] || OAUTH_RETURN_PAGES.crm;
      const separator = returnPath.includes('?') ? '&' : '?';
      res.redirect(`${returnPath}${separator}oauth=connected`);
    } catch (err) {
      res.status(500).send(`OAuth connection failed: ${err.message}`);
    }
  });

  // GET /api/oauth/:service/status — check OAuth connection status
  router.get('/:service/status', verifyUser, async (req, res) => {
    const { service } = req.params;
    const { data, error } = await supabase.from('wb_oauth_tokens')
      .select('*').eq('user_id', req.user.id).eq('service', service).single();
    if (error && error.code !== 'PGRST116') logDbError('status lookup wb_oauth_tokens', error); // PGRST116 = no rows, expected when never connected
    if (error || !data) return res.json({ connected: false });

    // Decrypt and return masked token info
    const isConnected = !!data.access_token_enc;
    const scopes = data.scopes || [];
    res.json({
      connected: isConnected,
      email: data.metadata?.email,
      expires_at: data.expires_at,
      scopes,
      has_docs_scope: scopes.includes('https://www.googleapis.com/auth/documents.readonly'),
      pages: data.metadata?.pages || []
    });
  });

  // GET /api/oauth/google/sheets — list Google Sheets accessible to user
  router.get('/google/sheets', verifyUser, async (req, res) => {
    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken(req.user.id);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    try {
      // Use query parameter format instead of path parameter for better filtering
      const sheetsRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet'&fields=files(id,name,mimeType)&spaces=drive`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const sheetsData = await sheetsRes.json();
      if (!sheetsRes.ok) throw new Error(sheetsData.error?.message || 'Failed to fetch sheets');
      // Filter to ensure only actual spreadsheets are returned
      const sheets = (sheetsData.files || []).filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
      res.json({ sheets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/oauth/google/worksheets/:spreadsheetId — list worksheets in a spreadsheet
  router.get('/google/worksheets/:spreadsheetId', verifyUser, async (req, res) => {
    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken(req.user.id);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const spreadsheetId = req.params.spreadsheetId;

    try {
      const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(title))`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const metaData = await metaRes.json();
      if (!metaRes.ok) throw new Error(metaData.error?.message || 'Failed to fetch worksheets');
      const worksheets = (metaData.sheets || []).map(s => s.properties.title).filter(Boolean);
      res.json({ worksheets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/oauth/google/columns/:spreadsheetId/:worksheet — list column headers from a worksheet
  router.get('/google/columns/:spreadsheetId/:worksheet', verifyUser, async (req, res) => {
    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken(req.user.id);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const { spreadsheetId, worksheet } = req.params;

    try {
      // ZZ (not Z) so sheets with >26 columns still get their headers read;
      // encodeURIComponent so tab names with spaces/#/&/? don't break the URL.
      const range = encodeURIComponent(`${worksheet}!A1:ZZ1`);
      const valuesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const valuesData = await valuesRes.json();
      if (!valuesRes.ok) throw new Error(valuesData.error?.message || 'Failed to fetch columns');
      const columns = (valuesData.values && valuesData.values[0]) ? valuesData.values[0].filter(c => c && c.trim()) : [];
      res.json({ columns });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/oauth/google/docs — list Google Docs accessible to user
  router.get('/google/docs', verifyUser, async (req, res) => {
    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken(req.user.id);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    try {
      const docsRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.document'&fields=files(id,name,mimeType,modifiedTime)&spaces=drive`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const docsData = await docsRes.json();
      if (!docsRes.ok) throw new Error(docsData.error?.message || 'Failed to fetch docs');
      const docs = (docsData.files || []).filter(f => f.mimeType === 'application/vnd.google-apps.document');
      res.json({ docs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/oauth/google/doc-content/:docId — fetch a doc's plain text for use
  // as AI grounding context. Requires the documents.readonly scope granted at
  // connect time — a connection made before that scope existed will 403 here
  // until the user disconnects and reconnects Google.
  router.get('/google/doc-content/:docId', verifyUser, async (req, res) => {
    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken(req.user.id);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const { docId } = req.params;

    try {
      const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const docData = await docRes.json();
      if (!docRes.ok) {
        // Docs API 403s with PERMISSION_DENIED both for "wrong doc owner" and
        // "token doesn't have documents.readonly" — the latter is by far the
        // more common cause given this scope only just got added, so say so.
        const message = docData.error?.message || 'Failed to fetch document';
        const status = docRes.status === 403 ? 403 : 500;
        return res.status(status).json({
          error: status === 403
            ? `${message} — if this document previously worked, your Google connection may predate Docs access; disconnect and reconnect Google to grant it.`
            : message
        });
      }

      // Docs API returns structured content (paragraphs -> elements -> textRun);
      // flatten to plain text for use as AI context.
      const text = (docData.body?.content || [])
        .map(block => (block.paragraph?.elements || [])
          .map(el => el.textRun?.content || '')
          .join(''))
        .join('');

      res.json({ id: docId, title: docData.title, text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/oauth/:service/disconnect — revoke OAuth connection
  router.post('/:service/disconnect', verifyUser, async (req, res) => {
    const { service } = req.params;
    const { error } = await supabase.from('wb_oauth_tokens').delete()
      .eq('user_id', req.user.id).eq('service', service);
    if (error) {
      logDbError('disconnect delete wb_oauth_tokens', error);
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
  });

  // ── Helper: Execute Flow ─────────────────────────────────────────────
  async function executeFlow(supabase, flow, executionId, triggerData) {
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];

    // Find trigger node
    const triggerNode = nodes.find(n => n.type === 'trigger');
    if (!triggerNode) {
      await supabase.from('wb_flow_executions').update({
        status: 'failed', error_message: 'No trigger node found', completed_at: new Date().toISOString()
      }).eq('id', executionId);
      return;
    }

    // Build execution context
    let context = { ...triggerData, $flow: flow, $trigger: triggerNode.config, $userId: flow.user_id };
    let currentNodeId = triggerNode.id;
    let visited = new Set();

    while (currentNodeId && !visited.has(currentNodeId)) {
      visited.add(currentNodeId);
      const node = nodes.find(n => n.id === currentNodeId);
      if (!node) break;

      // Log node start
      await supabase.from('wb_flow_node_results').insert({
        execution_id: executionId, node_id: node.id, node_type: node.type,
        status: 'running', input_data: context
      });

      try {
        // Execute node based on type
        const result = await executeNode(supabase, node, context);
        context = { ...context, ...result.output };

        // Update node result
        await supabase.from('wb_flow_node_results')
          .update({ status: 'success', output_data: result.output, completed_at: new Date().toISOString() })
          .eq('execution_id', executionId).eq('node_id', node.id);

        // Find next node via edges
        const edge = edges.find(e => e.sourceNodeId === currentNodeId);
        currentNodeId = edge ? edge.targetNodeId : null;
      } catch (err) {
        await supabase.from('wb_flow_node_results')
          .update({ status: 'failed', error_message: err.message, completed_at: new Date().toISOString() })
          .eq('execution_id', executionId).eq('node_id', node.id);

        await supabase.from('wb_flow_executions').update({
          status: 'failed', error_message: err.message, completed_at: new Date().toISOString()
        }).eq('id', executionId);

        await supabase.from('wb_flows').update({
          status: 'error', last_error: err.message, updated_at: new Date().toISOString()
        }).eq('id', flow.id);
        return;
      }
    }

    // Mark execution complete
    await supabase.from('wb_flow_executions').update({
      status: 'completed', completed_at: new Date().toISOString()
    }).eq('id', executionId);

    await supabase.from('wb_flows').update({
      last_run_at: new Date().toISOString(), status: 'active', updated_at: new Date().toISOString()
    }).eq('id', flow.id);
  }

  async function executeNode(supabase, node, context) {
    switch (node.type) {
      case 'trigger':
        return { output: context };

      case 'action':
        if (node.subtype === 'send_email') {
          // Send email via Gmail OAuth
          let accessToken;
          try {
            accessToken = await getValidGoogleAccessToken(context.$userId);
          } catch (err) {
            throw new Error(`Gmail not connected: ${err.message}`);
          }

          const to = renderTemplate(node.config.to, context);
          const subject = renderTemplate(node.config.subject, context);
          const body = renderTemplate(node.config.body, context);

          const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              raw: Buffer.from(
                `To: ${to}\nSubject: ${subject}\n\n${body}`
              ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
            })
          });

          if (!gmailRes.ok) {
            const err = await gmailRes.json();
            throw new Error(`Gmail API error: ${err.error?.message || 'Failed to send'}`);
          }

          return { output: { sent: true, messageId: context.$lastMessageId } };
        }

        if (node.subtype === 'add_sheet_row') {
          // Add row to Google Sheet
          let accessToken;
          try {
            accessToken = await getValidGoogleAccessToken(context.$userId);
          } catch (err) {
            throw new Error(`Google Sheets not connected: ${err.message}`);
          }

          const sheetId = node.config.sheetId;
          const range = node.config.range || 'Sheet1!A1';
          const values = node.config.values.map(v => [renderTemplate(v, context)]);

          const sheetsRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values })
          });

          if (!sheetsRes.ok) {
            const err = await sheetsRes.json();
            throw new Error(`Sheets API error: ${err.error?.message || 'Failed to append row'}`);
          }

          return { output: { added: true } };
        }

        if (node.subtype === 'send_message') {
          // Send WhatsApp/IG/FB message
          const channel = node.config.channel || 'whatsapp';
          const body = renderTemplate(node.config.body, context);

          // Use existing sendChannelMessage from CRM
          // This would need to be passed in as dependency
          return { output: { sent: true, channel } };
        }

        if (node.subtype === 'http_request') {
          // Generic HTTP request node
          const { method = 'GET', url, headers = {}, body: rawBody } = node.config;
          const renderedUrl = renderTemplate(url, context);
          const renderedHeaders = Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k, renderTemplate(v, context)])
          );
          const renderedBody = rawBody ? JSON.parse(renderTemplate(JSON.stringify(rawBody), context)) : undefined;

          const httpRes = await fetch(renderedUrl, {
            method,
            headers: renderedHeaders,
            body: renderedBody ? JSON.stringify(renderedBody) : undefined
          });

          const responseData = await httpRes.json().catch(() => ({}));
          return { output: { status: httpRes.status, data: responseData } };
        }

        if (node.subtype === 'delay') {
          const minutes = parseInt(node.config.minutes) || 0;
          if (minutes > 0) {
            await new Promise(resolve => setTimeout(resolve, minutes * 60 * 1000));
          }
          return { output: { delayed: true } };
        }

        return { output: {} };

      case 'condition':
        // Simple if/else branching
        const { operator = 'equals', field, value } = node.config;
        const fieldValue = context[field];

        let conditionMet = false;
        if (operator === 'equals') conditionMet = fieldValue == value;
        else if (operator === 'not_equals') conditionMet = fieldValue != value;
        else if (operator === 'contains') conditionMet = String(fieldValue).includes(String(value));
        else if (operator === 'greater_than') conditionMet = Number(fieldValue) > Number(value);
        else if (operator === 'less_than') conditionMet = Number(fieldValue) < Number(value);

        return { output: { conditionMet, branch: conditionMet ? 'true' : 'false' } };

      default:
        return { output: {} };
    }
  }

  function renderTemplate(template, context) {
    if (!template) return '';
    return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] ?? '');
  }

  return router;
};