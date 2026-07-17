// src/routes/leads.js — Unified Leads CRM: CRUD, timeline, notes, per-channel messages.
// Mounted in server.js as: app.use('/api/leads', verifyUser, require('./src/routes/leads')(deps));
//
// `deps` gives this module the same building blocks server.js already has,
// so we don't duplicate Supabase client setup or WhatsApp send logic.
const express = require('express');

const createChannelSender = require('../channel-send');
const { validateInteractiveObject, WhatsAppValidationError } = require('../whatsapp-interactive');

module.exports = function leadsRouter(deps) {
  const { supabase } = deps;
  const sendChannelMessage = createChannelSender(deps);
  const router = express.Router();

  const STATUSES = ['new', 'contacted', 'engaged', 'booked', 'won', 'follow_up', 'cold'];

  async function logEvent(leadId, type, payload, userId) {
    await supabase.from('wb_lead_events').insert({ lead_id: leadId, type, payload, created_by: userId || null });
  }

  async function touchLead(leadId) {
    await supabase.from('wb_leads').update({ last_activity_at: new Date().toISOString() }).eq('id', leadId);
  }

  // GET /api/leads?q=&source=&status=
  router.get('/', async (req, res) => {
    const { q, source, status, assigned_to } = req.query;
    let query = supabase.from('wb_leads').select('*').eq('user_id', req.user.id).order('last_activity_at', { ascending: false });
    if (source) query = query.eq('primary_source', source);
    if (status) query = query.eq('status', status);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);
    if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ leads: data || [] });
  });

  // POST /api/leads — manual creation
  router.post('/', async (req, res) => {
    const { name, phone, email, primary_source = 'manual', tags = [], custom_fields = {} } = req.body || {};
    if (!name && !phone && !email) return res.status(400).json({ error: 'name, phone, or email is required' });
    const { data, error } = await supabase.from('wb_leads')
      .insert({ user_id: req.user.id, name, phone, email, primary_source, tags, custom_fields })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    await logEvent(data.id, 'status_change', { to: 'new', note: 'Lead created' }, req.user.id);
    res.json({ lead: data });
  });

  // GET /api/leads/:id
  router.get('/:id', async (req, res) => {
    const { data, error } = await supabase.from('wb_leads').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (error || !data) return res.status(404).json({ error: 'Lead not found' });
    res.json({ lead: data });
  });

  // PUT /api/leads/:id
  router.put('/:id', async (req, res) => {
    const { status, name, phone, email, tags, custom_fields, assigned_to } = req.body || {};
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

    const { data: existing } = await supabase.from('wb_leads').select('status').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const patch = { updated_at: new Date().toISOString() };
    if (status !== undefined) patch.status = status;
    if (name !== undefined) patch.name = name;
    if (phone !== undefined) patch.phone = phone;
    if (email !== undefined) patch.email = email;
    if (tags !== undefined) patch.tags = tags;
    if (custom_fields !== undefined) patch.custom_fields = custom_fields;
    if (assigned_to !== undefined) patch.assigned_to = assigned_to;

    const { data, error } = await supabase.from('wb_leads').update(patch).eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (status && status !== existing.status) await logEvent(req.params.id, 'status_change', { from: existing.status, to: status }, req.user.id);
    res.json({ lead: data });
  });

  // DELETE /api/leads/:id
  router.delete('/:id', async (req, res) => {
    const { error } = await supabase.from('wb_leads').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // GET /api/leads/:id/events — unified timeline
  router.get('/:id/events', async (req, res) => {
    const owns = await supabase.from('wb_leads').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!owns.data) return res.status(404).json({ error: 'Lead not found' });
    const { data, error } = await supabase.from('wb_lead_events').select('*').eq('lead_id', req.params.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const events = (data || []).map(e => ({
      ...e,
      summary: e.type === 'status_change' ? `Status changed${e.payload?.from ? ` from ${e.payload.from}` : ''} to ${e.payload?.to}`
        : e.type === 'note' ? `Note: ${e.payload?.body || ''}`
        : e.type === 'meeting_booked' ? `Meeting booked: ${e.payload?.event_name || ''}`
        : e.type === 'auto_message' ? `Automated message sent via ${e.payload?.channel || ''}`
        : e.type === 'manual_message' ? `Message sent via ${e.payload?.channel || ''}`
        : e.type
    }));
    res.json({ events });
  });

  // GET /api/leads/:id/notes
  router.get('/:id/notes', async (req, res) => {
    const { data, error } = await supabase.from('wb_lead_events').select('*').eq('lead_id', req.params.id).eq('type', 'note').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ notes: (data || []).map(e => ({ id: e.id, body: e.payload?.body, created_at: e.created_at })) });
  });

  // POST /api/leads/:id/notes
  router.post('/:id/notes', async (req, res) => {
    const { body } = req.body || {};
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' });
    const owns = await supabase.from('wb_leads').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!owns.data) return res.status(404).json({ error: 'Lead not found' });
    await logEvent(req.params.id, 'note', { body: body.trim() }, req.user.id);
    await touchLead(req.params.id);
    res.json({ success: true });
  });

  // GET /api/leads/:id/messages?channel=whatsapp|instagram|facebook|email
  router.get('/:id/messages', async (req, res) => {
    const { channel } = req.query;
    if (!channel) return res.status(400).json({ error: 'channel is required' });
    const { data, error } = await supabase.from('wb_channel_messages')
      .select('*').eq('lead_id', req.params.id).eq('channel', channel).order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
  });

  // POST /api/leads/:id/messages — send an outbound message on a given channel
  //
  // `body` is normally free text. But it also doubles as the paste target for
  // WhatsApp interactive JSON (buttons/list/cta_url) copied out of the AI
  // assistant's "Generate JSON" tab or Meta's docs — previously that JSON got
  // sent to Meta as literal `type: "text"` body, so the contact saw the raw
  // JSON string instead of tappable buttons/a list. Now: if `body` parses as
  // JSON shaped like a WhatsApp interactive object (or `{ interactive: {...} }`),
  // or an explicit `interactive` field is passed, it's validated against
  // Meta's real limits and sent as a proper `type: "interactive"` message.
  router.post('/:id/messages', async (req, res) => {
    const { channel, body, interactive: explicitInteractive } = req.body || {};
    if (!channel || (!body?.trim() && !explicitInteractive)) {
      return res.status(400).json({ error: 'channel and body (or interactive) are required' });
    }

    const { data: lead } = await supabase.from('wb_leads').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    lead.user_id = req.user.id; // sender needs this to look up the right wa_accounts row

    const trimmedBody = body ? body.trim() : '';
    let interactive = explicitInteractive || null;

    if (!interactive && channel === 'whatsapp' && trimmedBody.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmedBody);
        const candidate = parsed && typeof parsed.interactive === 'object' ? parsed.interactive : parsed;
        if (candidate && typeof candidate === 'object' && ['button', 'list', 'cta_url'].includes(candidate.type)) {
          interactive = candidate;
        }
      } catch (_) {
        // Not JSON (or not interactive-shaped) — falls through and sends as plain text, as before.
      }
    }

    if (interactive) {
      try {
        validateInteractiveObject(interactive);
      } catch (err) {
        const status = err instanceof WhatsAppValidationError ? 400 : 500;
        return res.status(status).json({ error: `Interactive JSON failed WhatsApp validation: ${err.message}` });
      }
    }

    // Store a human-readable preview in the CRM thread rather than the raw JSON blob.
    const storedBody = interactive ? (interactive.body?.text || `[Interactive ${interactive.type} message]`) : trimmedBody;

    try {
      const msg = await sendChannelMessage({ lead, channel, body: storedBody, interactive, isAutomation: false });
      res.json({ success: true, message: msg });
    } catch (err) {
      res.status(502).json({ error: err.message, message: err.message /* channel-send attaches the row here too */ });
    }
  });

  // GET /api/leads/:id/meetings
  router.get('/:id/meetings', async (req, res) => {
    const { data, error } = await supabase.from('wb_meetings').select('*').eq('lead_id', req.params.id).eq('user_id', req.user.id).order('start_time', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ meetings: data || [] });
  });

  return router;
};
