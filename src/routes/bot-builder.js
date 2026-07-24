// src/routes/bot-builder.js
//
// Same shape as src/routes/leads.js etc: a factory that takes the shared
// `crmDeps` object and returns a router. Mount in server.js next to the
// other CRM routers:
//
//   const botBuilderRouter = require('./src/routes/bot-builder');
//   app.use('/api/bot-builder', verifyUser, botBuilderRouter(crmDeps));
//
// Named `bot-builder` (not `chatbot`) deliberately — you already have
// src/routes/chatbot.js mounted at app.use('/api', chatbotRouter(crmDeps))
// exposing /api/chatbot-config and /api/chatbot/*. Worth a quick check on
// whether that module or automationsRouter/flowsRouter already cover any
// of this ground before running both in parallel.

const express = require('express');

module.exports = function botBuilderRouter(deps) {
  const { supabase } = deps;
  const router = express.Router();

  /* ------------------------- TEMPLATES ------------------------- */

  router.get('/templates', async (req, res) => {
    const { data, error } = await supabase
      .from('wb_bot_templates')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, templates: data || [] });
  });

  router.post('/templates', async (req, res) => {
    const { name, type, payload } = req.body || {};
    if (!name || !type || !payload) return res.status(400).json({ error: 'name, type and payload are required' });
    const { data, error } = await supabase
      .from('wb_bot_templates')
      .insert({ user_id: req.user.id, name, type, payload, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ success: true, template: data });
  });

  router.put('/templates/:id', async (req, res) => {
    const { name, type, payload } = req.body || {};
    const { data, error } = await supabase
      .from('wb_bot_templates')
      .update({ name, type, payload, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true, template: data });
  });

  router.delete('/templates/:id', async (req, res) => {
    const { error } = await supabase
      .from('wb_bot_templates')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  /* ---------------------------- RULES ---------------------------- */

  router.get('/rules', async (req, res) => {
    const { data, error } = await supabase
      .from('wb_bot_rules')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, rules: data || [] });
  });

  router.post('/rules', async (req, res) => {
    const r = req.body || {};
    if (!r.name || !Array.isArray(r.keywords) || !r.action?.type) {
      return res.status(400).json({ error: 'name, keywords, and action.type are required' });
    }
    const { data, error } = await supabase
      .from('wb_bot_rules')
      .insert({
        user_id: req.user.id,
        name: r.name,
        keywords: r.keywords,
        match_type: r.matchType || 'contains',
        action_type: r.action.type,
        action_template_id: r.action.templateId || null,
        ai_prompt: r.action.aiPrompt || null,
        ai_fallback: r.action.aiFallback || null,
        conditions: r.conditions || [],
        else_template_id: r.elseTemplateId || null,
        action_config: r.action.config || {},
        follow_up: (() => {
          const fu = r.followUp || { enabled: false };
          if (fu.enabled && fu.hours) {
            fu.hours = Math.min(fu.hours, 20);
          }
          return fu;
        })(),
        active: r.active !== false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ success: true, rule: data });
  });

  router.put('/rules/:id', async (req, res) => {
    const r = req.body || {};
    const { data, error } = await supabase
      .from('wb_bot_rules')
      .update({
        name: r.name,
        keywords: r.keywords || [],
        match_type: r.matchType || 'contains',
        action_type: r.action?.type,
        action_template_id: r.action?.templateId || null,
        ai_prompt: r.action?.aiPrompt || null,
        ai_fallback: r.action?.aiFallback || null,
        conditions: r.conditions || [],
        else_template_id: r.elseTemplateId || null,
        action_config: r.action?.config || {},
        follow_up: (() => {
          const fu = r.followUp || { enabled: false };
          if (fu.enabled && fu.hours) {
            fu.hours = Math.min(fu.hours, 20);
          }
          return fu;
        })(),
        active: r.active !== false,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true, rule: data });
  });

  router.delete('/rules/:id', async (req, res) => {
    const { error } = await supabase
      .from('wb_bot_rules')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  return router;
};