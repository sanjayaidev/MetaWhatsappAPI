// src/routes/webhooks-inbound.js — public lead-capture endpoints.
// These are NOT behind verifyUser: the caller is a Google Sheets Apps Script
// (or, later, any generic form tool) hitting a per-user token'd URL, not a
// logged-in dashboard user. Auth is the unguessable token itself.
const express = require('express');
const crypto = require('crypto');

module.exports = function webhooksInboundRouter(deps) {
  const { supabase } = deps;
  const createChannelSender = require('../channel-send');
  const sendChannelMessage = createChannelSender(deps);
  const { runAutomationsForLead } = require('./automations');

  const router = express.Router();

  // Apply a field mapping ({source_field -> maps_to/tag}) to a raw payload,
  // returning { name, phone, email, custom_fields }.
  function applyMapping(rawRow, mappings) {
    const out = { custom_fields: {} };
    for (const m of mappings || []) {
      const value = rawRow[m.source_field];
      if (value === undefined || value === null || value === '') continue;
      if (m.maps_to === 'name' || m.maps_to === 'phone' || m.maps_to === 'email') out[m.maps_to] = value;
      else if (m.maps_to === 'tag') { out.tags = out.tags || []; out.tags.push(value); }
      else if (m.tag) out.custom_fields[m.tag] = value;
    }
    return out;
  }

  async function captureLead({ userId, channel, rawRow, res }) {
    const { data: mappingRow } = await supabase.from('wb_field_mappings').select('mappings, template_id, placeholder_mapping').eq('user_id', userId).eq('channel', channel).single();
    const mapped = applyMapping(rawRow, mappingRow?.mappings || []);

    if (!mapped.name && !mapped.phone && !mapped.email) {
      return res.status(400).json({ error: 'No mapped name/phone/email found in payload — check Field Mapping settings for this source.' });
    }

    const { data: lead, error } = await supabase.from('wb_leads').insert({
      user_id: userId, name: mapped.name, phone: mapped.phone, email: mapped.email,
      primary_source: channel, tags: mapped.tags || [], custom_fields: mapped.custom_fields
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    lead.user_id = userId;

    await supabase.from('wb_lead_sources').insert({ lead_id: lead.id, channel, external_id: mapped.phone || mapped.email || lead.id, raw_payload: rawRow }).catch(() => {});
    await supabase.from('wb_lead_events').insert({ lead_id: lead.id, type: 'status_change', payload: { to: 'new', note: `Captured via ${channel}` } });

    // Send auto-reply using template if configured for this channel
    if (mappingRow?.template_id) {
      sendAutoReplyTemplate({ supabase, sendChannelMessage, lead, channel, templateId: mappingRow.template_id, placeholderMapping: mappingRow.placeholder_mapping || {}, mappedFields: mapped }).catch(err => console.error('[auto-reply] error:', err.message));
    } else {
      // Fall back to automations if no template configured
      runAutomationsForLead({ supabase, sendChannelMessage, lead, source: channel }).catch(err => console.error('[automation] error:', err.message));
    }

    res.json({ success: true, lead_id: lead.id });
  }

  // POST /api/hooks/sheet/:token — Google Apps Script (bound to your sheet) posts each new row here.
  router.post('/sheet/:token', async (req, res) => {
    const { data: endpoint } = await supabase.from('wb_webhook_endpoints').select('*').eq('token', req.params.token).eq('channel', 'sheet').single();
    if (!endpoint) return res.status(404).json({ error: 'Invalid or expired webhook URL' });
    await captureLead({ userId: endpoint.user_id, channel: 'sheet', rawRow: req.body || {}, res });
  });

  // POST /api/hooks/form/:token — generic form-tool webhook (kept for later use).
  router.post('/form/:token', async (req, res) => {
    const { data: endpoint } = await supabase.from('wb_webhook_endpoints').select('*').eq('token', req.params.token).eq('channel', 'webform').single();
    if (!endpoint) return res.status(404).json({ error: 'Invalid or expired webhook URL' });
    await captureLead({ userId: endpoint.user_id, channel: 'webform', rawRow: req.body || {}, res });
  });

  return router;
};

// ── Auto-reply template sender for new leads from webhooks ──
async function sendAutoReplyTemplate({ supabase, sendChannelMessage, lead, channel, templateId, placeholderMapping, mappedFields }) {
  const { data: tpl, error } = await supabase.from('wb_templates').select('*').eq('id', templateId).single();
  if (error || !tpl) {
    console.error('[auto-reply] template not found:', templateId);
    return;
  }
  if (tpl.status !== 'APPROVED') {
    console.error('[auto-reply] template not approved:', tpl.status);
    return;
  }

  const mergeFields = { name: lead.name || '', phone: lead.phone || '', email: lead.email || '', ...(mappedFields.custom_fields || {}) };

  const resolveValue = (map) => {
    if (map.type === 'name') return mergeFields.name || '';
    if (map.type === 'phone') return mergeFields.phone || '';
    if (map.type === 'email') return mergeFields.email || '';
    if (map.type === 'field') return mergeFields[map.field] ?? '';
    if (map.type === 'custom') return map.value || '';
    return '';
  };

  const entries = Object.entries(placeholderMapping || {});
  const isPositional = entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key));

  let params = [];
  let previewBody = tpl.body || '';
  if (isPositional) {
    params = entries
      .map(([key, map]) => ({ position: parseInt(key, 10), text: String(resolveValue(map)) }))
      .sort((a, b) => a.position - b.position)
      .map(({ text }) => ({ type: 'text', text }));
    entries.forEach(([key, map]) => { previewBody = previewBody.replace(`{{${key}}}`, String(resolveValue(map))); });
  } else {
    params = entries.map(([key, map]) => ({ type: 'text', parameter_name: key, text: String(resolveValue(map)) }));
    entries.forEach(([key, map]) => { previewBody = previewBody.replace(`{{${key}}}`, String(resolveValue(map))); });
  }

  const template = { name: tpl.name, language: { code: tpl.language || 'en_US' } };
  if (params.length) template.components = [{ type: 'BODY', parameters: params }];

  // Send via WhatsApp using the template
  await sendChannelMessage({ lead, channel: 'whatsapp', body: previewBody, isAutomation: true, template });
}

// ── Webhook URL management (mounted separately, behind verifyUser) ──────
module.exports.endpointsRouter = function endpointsRouter(deps) {
  const { supabase, verifyUser, SELF_URL } = deps;
  const router = express.Router();

  router.get('/', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_webhook_endpoints').select('*').eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ endpoints: (data || []).map(e => ({ ...e, url: `${SELF_URL}/api/hooks/${e.channel}/${e.token}` })) });
  });

  router.post('/', verifyUser, async (req, res) => {
    const { channel } = req.body || {};
    if (!['sheet', 'webform'].includes(channel)) return res.status(400).json({ error: 'channel must be sheet or webform' });
    const token = crypto.randomBytes(20).toString('hex');
    const { data, error } = await supabase.from('wb_webhook_endpoints')
      .upsert({ user_id: req.user.id, channel, token }, { onConflict: 'user_id,channel' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ endpoint: data, url: `${SELF_URL}/api/hooks/${channel}/${data.token}` });
  });

  return router;
};
