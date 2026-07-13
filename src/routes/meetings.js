// src/routes/meetings.js — meetings list (dashboard) + smbooking webhook receiver.
// Two different auth models live here: GET / is a normal verifyUser dashboard
// route; POST /webhook/:token is public (smbooking calls it directly) and is
// authenticated instead via the per-user webhook_secret stored on the
// wb_integrations row for type='smbooking'.
const express = require('express');

module.exports = function meetingsRouter(deps) {
  const { supabase, decryptToken, verifyUser } = deps;
  const router = express.Router();

  // GET /api/meetings — dashboard list, joined with lead name for display
  router.get('/', verifyUser, async (req, res) => {
    const { data: meetings, error } = await supabase.from('wb_meetings').select('*').eq('user_id', req.user.id).order('start_time', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const leadIds = [...new Set((meetings || []).map(m => m.lead_id).filter(Boolean))];
    let leadNames = {};
    if (leadIds.length) {
      const { data: leads } = await supabase.from('wb_leads').select('id,name').in('id', leadIds);
      leadNames = Object.fromEntries((leads || []).map(l => [l.id, l.name]));
    }
    res.json({ meetings: (meetings || []).map(m => ({ ...m, lead_name: leadNames[m.lead_id] || null })) });
  });

  // POST /api/meetings/webhook/:userId — smbooking calls this on booking create/update/cancel.
  // Body expected: { secret, external_booking_id, event_name, start_time, end_time, status, lead: {name,phone,email} }
  router.post('/webhook/:userId', async (req, res) => {
    const { userId } = req.params;
    const { secret, external_booking_id, event_name, start_time, end_time, status = 'scheduled', lead: leadInfo } = req.body || {};

    const { data: integration } = await supabase.from('wb_integrations').select('*').eq('user_id', userId).eq('type', 'smbooking').eq('status', 'connected').single();
    if (!integration) return res.status(404).json({ error: 'smbooking is not connected for this account' });
    const storedSecret = integration.config?.webhook_secret ? decryptToken(integration.config.webhook_secret) : null;
    if (!storedSecret || storedSecret !== secret) return res.status(401).json({ error: 'Invalid webhook secret' });

    // Match or create the lead this booking belongs to.
    let lead = null;
    if (leadInfo?.phone || leadInfo?.email) {
      const orFilter = [leadInfo.phone && `phone.eq.${leadInfo.phone}`, leadInfo.email && `email.eq.${leadInfo.email}`].filter(Boolean).join(',');
      const { data: existing } = await supabase.from('wb_leads').select('*').eq('user_id', userId).or(orFilter).limit(1);
      lead = existing?.[0] || null;
    }
    if (!lead && leadInfo) {
      const { data: created } = await supabase.from('wb_leads').insert({
        user_id: userId, name: leadInfo.name, phone: leadInfo.phone, email: leadInfo.email, primary_source: 'manual', status: 'booked'
      }).select().single();
      lead = created;
    }

    let meeting, error;
    const { data: existingMeeting } = await supabase.from('wb_meetings').select('id').eq('user_id', userId).eq('external_booking_id', external_booking_id).single();
    if (existingMeeting) {
      ({ data: meeting, error } = await supabase.from('wb_meetings')
        .update({ lead_id: lead?.id || null, event_name, start_time, end_time, status })
        .eq('id', existingMeeting.id).select().single());
    } else {
      ({ data: meeting, error } = await supabase.from('wb_meetings')
        .insert({ user_id: userId, lead_id: lead?.id || null, external_booking_id, event_name, start_time, end_time, status })
        .select().single());
    }
    if (error) return res.status(500).json({ error: error.message });

    if (lead) {
      await supabase.from('wb_lead_events').insert({ lead_id: lead.id, type: 'meeting_booked', payload: { event_name, start_time, status } });
      await supabase.from('wb_leads').update({ status: status === 'cancelled' ? lead.status : 'booked', last_activity_at: new Date().toISOString() }).eq('id', lead.id);
    }

    res.json({ success: true, meeting });
  });

  return router;
};
