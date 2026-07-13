// src/channel-send.js — single place that knows how to actually send a message
// on a given channel (WhatsApp today; Instagram/Facebook/Email queued until
// their integrations are wired up). Used by both src/routes/leads.js (manual
// replies) and src/routes/automations.js (auto first-touch/follow-up).
module.exports = function createChannelSender({ supabase, decryptToken, META_API_VERSION, fetch }) {
  return async function sendChannelMessage({ lead, channel, body, isAutomation = false }) {
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
          const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: lead.phone, type: 'text', text: { body } })
          });
          const responseData = await result.json();
          if (!result.ok || !responseData.messages?.[0]?.id) throw new Error(responseData.error?.message || `Meta API ${result.status}`);
          externalId = responseData.messages[0].id;
        } catch (err) { sendError = err.message; }
      }
    } else if (channel === 'instagram' || channel === 'facebook') {
      // TODO: wire up once the Instagram/Facebook Meta app (Graph API messaging) is ready.
      status = 'queued';
    } else if (channel === 'email') {
      // TODO: wire up once Gmail send integration (wb_integrations type=gmail) is connected.
      status = 'queued';
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
