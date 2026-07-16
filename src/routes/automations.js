// src/routes/automations.js — first-touch / follow-up automation rules.
// Actual firing happens where new leads are created (webhooks-inbound.js,
// social-webhooks) via runAutomationsForLead(), exported below.
const express = require('express');

module.exports = function automationsRouter(deps) {
  const { supabase } = deps;
  const router = express.Router();

  const VALID_TRIGGERS = ['any', 'whatsapp', 'instagram', 'facebook', 'webform', 'sheet', 'email'];
  const VALID_CHANNELS = ['all', 'whatsapp', 'instagram', 'facebook', 'email'];

  router.get('/', async (req, res) => {
    const { data, error } = await supabase.from('wb_automations').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ automations: data || [] });
  });

  router.post('/', async (req, res) => {
    const { trigger_source = 'any', channel = 'all', message_body, template_id, placeholder_mapping = {}, delay_minutes = 0, active = true } = req.body || {};
    if (!VALID_TRIGGERS.includes(trigger_source)) return res.status(400).json({ error: `trigger_source must be one of: ${VALID_TRIGGERS.join(', ')}` });
    if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` });
    
    // WhatsApp requires an approved template for business-initiated messages
    if (channel === 'whatsapp' || (channel === 'all')) {
      if (!template_id) return res.status(400).json({ error: 'template_id is required for WhatsApp automations — pick an approved template' });
      const { data: tpl } = await supabase.from('wb_templates').select('id, status').eq('id', template_id).eq('user_id', req.user.id).single();
      if (!tpl) return res.status(400).json({ error: 'Template not found' });
      if (tpl.status !== 'APPROVED') return res.status(400).json({ error: 'That template is not APPROVED by Meta yet — select an approved one' });
    } else if (!message_body?.trim()) {
      return res.status(400).json({ error: 'message_body is required for non-WhatsApp channels' });
    }

    const { data, error } = await supabase.from('wb_automations')
      .insert({ 
        user_id: req.user.id, 
        trigger_source, 
        channel, 
        message_body: channel === 'whatsapp' || channel === 'all' ? null : message_body.trim(),
        template_id: channel === 'whatsapp' || channel === 'all' ? template_id : null,
        placeholder_mapping: channel === 'whatsapp' || channel === 'all' ? placeholder_mapping : {},
        delay_minutes, 
        active 
      })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ automation: data });
  });

  router.put('/:id', async (req, res) => {
    const patch = {};
    ['trigger_source', 'channel', 'message_body', 'template_id', 'placeholder_mapping', 'delay_minutes', 'active'].forEach(k => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    
    // Validate template if channel is whatsapp or all
    if (patch.channel === 'whatsapp' || patch.channel === 'all' || (patch.template_id && !('channel' in patch))) {
      const templateId = patch.template_id;
      if (templateId) {
        const { data: tpl } = await supabase.from('wb_templates').select('id, status').eq('id', templateId).eq('user_id', req.user.id).single();
        if (!tpl) return res.status(400).json({ error: 'Template not found' });
        if (tpl.status !== 'APPROVED') return res.status(400).json({ error: 'That template is not APPROVED by Meta yet — select an approved one' });
      }
    }
    
    const { data, error } = await supabase.from('wb_automations').update(patch).eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ automation: data });
  });

  router.delete('/:id', async (req, res) => {
    const { error } = await supabase.from('wb_automations').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  return router;
};

// ── Fired by inbound-capture routes (webhooks-inbound.js, social webhooks) ──
// Not mounted as an HTTP route — imported directly as a function.
// Renders {tag} merge fields from the lead's name/phone/email/custom_fields,
// applies the configured delay (best-effort setTimeout; for production scale
// swap this for a real job queue), and logs an auto_message lead event.
module.exports.runAutomationsForLead = async function runAutomationsForLead({ supabase, sendChannelMessage, lead, source }) {
  const { data: rules } = await supabase.from('wb_automations')
    .select('*').eq('user_id', lead.user_id).eq('active', true)
    .or(`trigger_source.eq.any,trigger_source.eq.${source}`);
  if (!rules?.length) return;

  const mergeFields = { name: lead.name || '', phone: lead.phone || '', email: lead.email || '', ...(lead.custom_fields || {}) };
  
  for (const rule of rules) {
    const fire = async () => {
      const channels = rule.channel === 'all' ? ['whatsapp', 'instagram', 'facebook', 'email'] : [rule.channel];
      for (const channel of channels) {
        try {
          // If template_id exists, use template-based sending (like sheet-poller does)
          if (rule.template_id && channel === 'whatsapp') {
            const { template, previewBody } = await buildWhatsAppTemplatePayload(supabase, rule, mergeFields);
            await sendChannelMessage({ lead, channel, body: previewBody, isAutomation: true, template });
          } else {
            const render = (tpl) => (tpl || '').replace(/\{(\w+)\}/g, (_, key) => mergeFields[key] ?? `{${key}}`);
            await sendChannelMessage({ lead, channel, body: render(rule.message_body), isAutomation: true });
          }
        } catch (err) {
          console.error(`[automation] failed to send via ${channel} for lead ${lead.id}:`, err.message);
        }
      }
    };
    if (rule.delay_minutes > 0) setTimeout(fire, rule.delay_minutes * 60 * 1000);
    else await fire();
  }
};

// Helper to build WhatsApp template payload (same logic as sheet-poller.js)
async function buildWhatsAppTemplatePayload(supabase, rule, mergeFields) {
  const { data: tpl, error } = await supabase.from('wb_templates').select('*').eq('id', rule.template_id).single();
  if (error || !tpl) throw new Error('Linked template not found');

  const resolveValue = (map) => {
    if (map.type === 'name') return mergeFields.name || '';
    if (map.type === 'phone') return mergeFields.phone || '';
    if (map.type === 'email') return mergeFields.email || '';
    if (map.type === 'field') return mergeFields[map.field] ?? '';
    if (map.type === 'custom') return map.value || '';
    return '';
  };

  const entries = Object.entries(rule.placeholder_mapping || {});
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

  return { template, previewBody };
}
