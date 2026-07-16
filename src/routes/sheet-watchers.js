// src/routes/sheet-watchers.js — manage polling-based sheet automations.
// Actual polling happens in src/sheet-poller.js; this just does CRUD + a
// manual "poll now" for testing without waiting for the interval.
const express = require('express');

module.exports = function sheetWatchersRouter(deps) {
  const { supabase, verifyUser } = deps;
  const router = express.Router();

  const VALID_TYPES = ['new_row', 'date_reminder'];
  const VALID_CHANNELS = ['whatsapp', 'email', 'instagram', 'facebook'];

  router.get('/', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_sheet_watchers').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ watchers: data || [] });
  });

  router.post('/', verifyUser, async (req, res) => {
    const {
      spreadsheet_id, spreadsheet_name, worksheet, watch_type,
      name_column, phone_column, email_column, date_column,
      offset_days = 0, message_template, channel = 'whatsapp',
      poll_interval_minutes = 15, active = true
    } = req.body || {};

    if (!spreadsheet_id || !worksheet) return res.status(400).json({ error: 'spreadsheet_id and worksheet are required' });
    if (!VALID_TYPES.includes(watch_type)) return res.status(400).json({ error: `watch_type must be one of: ${VALID_TYPES.join(', ')}` });
    if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` });
    if (!message_template?.trim()) return res.status(400).json({ error: 'message_template is required' });
    if (watch_type === 'date_reminder' && !date_column) return res.status(400).json({ error: 'date_column is required for date_reminder watchers' });
    if (poll_interval_minutes < 5) return res.status(400).json({ error: 'poll_interval_minutes must be at least 5' });

    const { data, error } = await supabase.from('wb_sheet_watchers').upsert({
      user_id: req.user.id, spreadsheet_id, spreadsheet_name, worksheet, watch_type,
      name_column, phone_column, email_column, date_column,
      offset_days, message_template: message_template.trim(), channel,
      poll_interval_minutes, active
    }, { onConflict: 'user_id,spreadsheet_id,worksheet,watch_type' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ watcher: data });
  });

  router.put('/:id', verifyUser, async (req, res) => {
    const patch = {};
    ['spreadsheet_name', 'name_column', 'phone_column', 'email_column', 'date_column',
      'offset_days', 'message_template', 'channel', 'poll_interval_minutes', 'active'].forEach(k => {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    });
    const { data, error } = await supabase.from('wb_sheet_watchers').update(patch).eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ watcher: data });
  });

  router.delete('/:id', verifyUser, async (req, res) => {
    const { error } = await supabase.from('wb_sheet_watchers').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // POST /api/sheet-watchers/:id/poll-now — force an immediate poll (bypasses the interval), for testing.
  router.post('/:id/poll-now', verifyUser, async (req, res) => {
    const { data: watcher, error } = await supabase.from('wb_sheet_watchers').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (error || !watcher) return res.status(404).json({ error: 'Watcher not found' });

    // Reset last_polled_at so the next global tick (within 60s) treats it as due.
    await supabase.from('wb_sheet_watchers').update({ last_polled_at: null }).eq('id', watcher.id);
    res.json({ success: true, message: 'Will poll within 60 seconds' });
  });

  return router;
};