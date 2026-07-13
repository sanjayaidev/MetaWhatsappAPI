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
    const { trigger_source = 'any', channel = 'all', message_body, delay_minutes = 0, active = true } = req.body || {};
    if (!VALID_TRIGGERS.includes(trigger_source)) return res.status(400).json({ error: `trigger_source must be one of: ${VALID_TRIGGERS.join(', ')}` });
    if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` });
    if (!message_body?.trim()) return res.status(400).json({ error: 'message_body is required' });

    const { data, error } = await supabase.from('wb_automations')
      .insert({ user_id: req.user.id, trigger_source, channel, message_body: message_body.trim(), delay_minutes, active })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ automation: data });
  });

  router.put('/:id', async (req, res) => {
    const patch = {};
    ['trigger_source', 'channel', 'message_body', 'delay_minutes', 'active'].forEach(k => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
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
  const render = (tpl) => (tpl || '').replace(/\{(\w+)\}/g, (_, key) => mergeFields[key] ?? `{${key}}`);

  for (const rule of rules) {
    const fire = async () => {
      const channels = rule.channel === 'all' ? ['whatsapp', 'instagram', 'facebook', 'email'] : [rule.channel];
      for (const channel of channels) {
        try {
          await sendChannelMessage({ lead, channel, body: render(rule.message_body), isAutomation: true });
        } catch (err) {
          console.error(`[automation] failed to send via ${channel} for lead ${lead.id}:`, err.message);
        }
      }
    };
    if (rule.delay_minutes > 0) setTimeout(fire, rule.delay_minutes * 60 * 1000);
    else await fire();
  }
};
