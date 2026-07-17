// src/channel-send.js — single place that knows how to actually send a message
// on a given channel (WhatsApp, Instagram, Facebook, Email). Used by both
// src/routes/leads.js (manual replies) and src/routes/automations.js /
// src/sheet-poller.js (automated sends).
//
// Instagram/Facebook/Email previously just set status='queued' with a TODO —
// they now use the tokens stored in wb_oauth_tokens (see src/google-auth.js
// and src/routes/flows.js's OAuth callback), the same table the "Sources"
// tab's Google/Facebook connect flow already populates, so no separate
// token plumbing is needed here.
module.exports = function createChannelSender({ supabase, decryptToken, encryptToken, META_API_VERSION, fetch }) {
  const { getValidGoogleAccessToken } = require('./google-auth')({ supabase, encryptToken, decryptToken, fetch });

  // Facebook/Instagram messaging both go through a Page (or the Page's linked
  // IG business account) access token, obtained via the Facebook OAuth flow
  // in flows.js and stored in wb_oauth_tokens.metadata.pages. This repo's
  // OAuth flow only captures one connected Facebook identity per user, so —
  // same simplifying assumption the rest of this CRM makes for WhatsApp
  // ("most recent active wa_accounts row") — we use the first page returned.
  async function getPageAccessToken(userId) {
    const { data: row } = await supabase.from('wb_oauth_tokens')
      .select('metadata').eq('user_id', userId).eq('service', 'facebook').single();
    const page = row?.metadata?.pages?.[0];
    if (!page?.access_token) throw new Error('Facebook/Instagram not connected — connect a Page under Sources in the CRM.');
    return page;
  }

  async function sendFacebookMessage(userId, psid, text) {
    const page = await getPageAccessToken(userId);
    const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/me/messages?access_token=${encodeURIComponent(page.access_token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { text } })
    });
    const data = await res.json();
    if (!res.ok || !data.message_id) throw new Error(data.error?.message || `Facebook Graph API ${res.status}`);
    return data.message_id;
  }

  // Instagram DMs use the same Graph "me/messages" call as Facebook Page
  // messaging once a Page has a linked IG business account — the recipient
  // id is the lead's Instagram-scoped id (IGSID), stored in wb_leads.ig_handle
  // once a lead has been matched via the IG webhook.
  async function sendInstagramMessage(userId, igsid, text) {
    const page = await getPageAccessToken(userId);
    const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/me/messages?access_token=${encodeURIComponent(page.access_token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: igsid }, message: { text } })
    });
    const data = await res.json();
    if (!res.ok || !data.message_id) throw new Error(data.error?.message || `Instagram Graph API ${res.status}`);
    return data.message_id;
  }

  // Sends via the Gmail API using the same Google OAuth token (with
  // gmail.send scope) that the "Sources" Google connection already
  // requests — refreshed on demand by getValidGoogleAccessToken, so this
  // doesn't go stale after ~1hr the way the old wb_integrations-based
  // Gmail token did.
  async function sendEmail(userId, toEmail, subject, text) {
    const accessToken = await getValidGoogleAccessToken(userId);
    const raw = Buffer.from(
      `To: ${toEmail}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${text}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ raw })
    });
    const data = await res.json();
    if (!res.ok || !data.id) throw new Error(data.error?.message || `Gmail API ${res.status}`);
    return data.id;
  }

  // `template`, when provided for the whatsapp channel, sends a Meta message
  // template ({ name, language, components }) instead of a free-text message.
  // WhatsApp requires this for any business-initiated send (reminders, wishes,
  // anything outside the 24h customer-service window) — free text will be
  // rejected by Meta outside that window. `body` is still passed for logging/
  // CRM display (a human-readable rendered preview of what was sent).
  //
  // `interactive`, when provided for the whatsapp channel, sends a proper
  // Meta "interactive" object (buttons/list/cta_url — see whatsapp-interactive.js)
  // instead of dumping that JSON as literal text. Takes priority over `body`
  // but not over `template` (a template send always wins if both are passed).
  return async function sendChannelMessage({ lead, channel, body, isAutomation = false, template = null, interactive = null }) {
    let status = 'sent';
    let externalId = null;
    let sendError = null;

    if (channel === 'whatsapp') {
      if (!lead.phone) {
        sendError = 'Lead has no phone number on file';
      } else {
        try {
          const { data: waAccounts } = await supabase.from('wa_accounts').select('*')
            .eq('user_id', lead.user_id).eq('is_active', true).order('created_at', { ascending: false }).limit(1);
          if (!waAccounts?.length) throw new Error('No active WhatsApp account connected');
          const waAccount = waAccounts[0];
          const plainToken = decryptToken(waAccount.access_token);

          const payload = template
            ? { messaging_product: 'whatsapp', to: lead.phone, type: 'template', template }
            : interactive
            ? { messaging_product: 'whatsapp', to: lead.phone, type: 'interactive', interactive }
            : { messaging_product: 'whatsapp', to: lead.phone, type: 'text', text: { body } };

          const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
            body: JSON.stringify(payload)
          });
          const responseData = await result.json();
          if (!result.ok || !responseData.messages?.[0]?.id) throw new Error(responseData.error?.message || `Meta API ${result.status}`);
          externalId = responseData.messages[0].id;
        } catch (err) { sendError = err.message; }
      }
    } else if (channel === 'facebook') {
      if (!lead.fb_psid) {
        sendError = 'Lead has no Facebook PSID on file (only inbound Messenger contacts can be replied to)';
      } else {
        try { externalId = await sendFacebookMessage(lead.user_id, lead.fb_psid, body); }
        catch (err) { sendError = err.message; }
      }
    } else if (channel === 'instagram') {
      if (!lead.ig_handle) {
        sendError = 'Lead has no Instagram-scoped id on file (only inbound IG contacts can be replied to)';
      } else {
        try { externalId = await sendInstagramMessage(lead.user_id, lead.ig_handle, body); }
        catch (err) { sendError = err.message; }
      }
    } else if (channel === 'email') {
      if (!lead.email) {
        sendError = 'Lead has no email address on file';
      } else {
        try { externalId = await sendEmail(lead.user_id, lead.email, 'A message from your CRM', body); }
        catch (err) { sendError = err.message; }
      }
    } else {
      sendError = `Unsupported channel: ${channel}`;
    }

    if (sendError) status = 'failed';

    const { data: msg, error } = await supabase.from('wb_channel_messages').insert({
      lead_id: lead.id, user_id: lead.user_id, channel, direction: 'out', body,
      status, external_message_id: externalId, meta: sendError ? { error: sendError } : {}
    }).select().single();
    if (error) throw new Error(error.message);

    await supabase.from('wb_lead_events').insert({
      lead_id: lead.id, type: isAutomation ? 'auto_message' : 'manual_message', payload: { channel, status }
    });
    await supabase.from('wb_leads').update({ last_activity_at: new Date().toISOString() }).eq('id', lead.id);

    if (sendError) throw Object.assign(new Error(sendError), { message: msg });
    return msg;
  };
};