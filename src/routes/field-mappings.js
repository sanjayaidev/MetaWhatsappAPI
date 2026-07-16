// src/routes/field-mappings.js — maps incoming form/sheet fields to lead fields & merge tags.
// Mounted with verifyUser applied at the server.js mount level.
const express = require('express');

module.exports = function fieldMappingsRouter(deps) {
  const { supabase } = deps;
  const router = express.Router();

  // GET /api/field-mappings?channel=webform|sheet
  router.get('/', async (req, res) => {
    const { channel } = req.query;
    if (!channel) return res.status(400).json({ error: 'channel is required' });
    const { data, error } = await supabase.from('wb_field_mappings').select('*').eq('user_id', req.user.id).eq('channel', channel).single();
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message }); // PGRST116 = no rows, that's fine
    res.json({ mappings: data?.mappings || [], template_id: data?.template_id, placeholder_mapping: data?.placeholder_mapping });
  });

  // POST /api/field-mappings  { channel, mappings: [{source_field, maps_to, tag}], template_id, placeholder_mapping }
  router.post('/', async (req, res) => {
    const { channel, mappings, template_id, placeholder_mapping } = req.body || {};
    if (!channel || !Array.isArray(mappings)) return res.status(400).json({ error: 'channel and mappings[] are required' });
    
    // Validate template if provided
    if (template_id) {
      const { data: tpl } = await supabase.from('wb_templates').select('id, status').eq('id', template_id).eq('user_id', req.user.id).single();
      if (!tpl) return res.status(400).json({ error: 'Template not found' });
      if (tpl.status !== 'APPROVED') return res.status(400).json({ error: 'That template is not APPROVED by Meta yet — select an approved one' });
    }
    
    const { data, error } = await supabase.from('wb_field_mappings')
      .upsert({ user_id: req.user.id, channel, mappings, template_id: template_id || null, placeholder_mapping: placeholder_mapping || {}, updated_at: new Date().toISOString() }, { onConflict: 'user_id,channel' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ mappings: data.mappings, template_id: data.template_id, placeholder_mapping: data.placeholder_mapping });
  });

  return router;
};
