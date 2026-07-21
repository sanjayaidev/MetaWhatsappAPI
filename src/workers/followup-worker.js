// src/workers/followup-worker.js
//
// Polls wb_bot_conversation_state for due, unsent follow-ups and sends them.
// Run as a standalone process, or start it from server.js next to your
// existing queue processor (see integration note at the bottom).
//
//   node src/workers/followup-worker.js
//
// Needs the same env vars server.js already loads (SUPABASE_URL,
// SUPABASE_SERVICE_KEY, plus whatever encryptToken/decryptToken use).

require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { decryptToken } = require('../crypto');

const META_API_VERSION = 'v23.0';
const POLL_INTERVAL_MS = 60 * 1000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function sendTemplateMessage({ userId, phone, templateId }) {
  const { data: tpl } = await supabase.from('wb_bot_templates').select('payload').eq('id', templateId).single();
  if (!tpl) { console.warn(`[followup-worker] template ${templateId} not found`); return; }

  const { data: waAccounts } = await supabase
    .from('wa_accounts')
    .select('phone_number_id, access_token')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!waAccounts?.length) { console.warn(`[followup-worker] no active wa_account for user ${userId}`); return; }

  const account = waAccounts[0];
  const plainToken = decryptToken(account.access_token);
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${account.phone_number_id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, ...tpl.payload })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Meta API ${res.status}`);
  }
}

async function processDueFollowUps() {
  const { data: due, error } = await supabase
    .from('wb_bot_conversation_state')
    .select('id, user_id, phone, replied_since_trigger, rule_id, wb_bot_rules(follow_up, active)')
    .eq('follow_up_sent', false)
    .not('follow_up_due_at', 'is', null)
    .lte('follow_up_due_at', new Date().toISOString());
  if (error) { console.error('[followup-worker] poll query failed', error); return; }

  for (const row of due || []) {
    const rule = row.wb_bot_rules;
    const followUp = rule?.follow_up || {};

    if (!rule?.active || !followUp.enabled) { await markSkipped(row.id); continue; }
    if (followUp.condition === 'no_reply' && row.replied_since_trigger) { await markSkipped(row.id); continue; }
    // 'no_purchase' would need a Shopify order-status lookup here — stubbed as always-due.

    const templateId = followUp.template_id || followUp.templateId;
    if (!templateId) { await markSkipped(row.id); continue; }

    try {
      await sendTemplateMessage({ userId: row.user_id, phone: row.phone, templateId });
      await supabase.from('wb_bot_conversation_state')
        .update({ follow_up_sent: true, last_outbound_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id);
    } catch (err) {
      console.error(`[followup-worker] failed to send follow-up ${row.id}`, err.message);
    }
  }
}

async function markSkipped(id) {
  await supabase.from('wb_bot_conversation_state')
    .update({ follow_up_sent: true, updated_at: new Date().toISOString() })
    .eq('id', id);
}

async function loop() {
  try { await processDueFollowUps(); }
  catch (err) { console.error('[followup-worker] loop error', err.message); }
  setTimeout(loop, POLL_INTERVAL_MS);
}

if (require.main === module) {
  console.log('[followup-worker] starting, polling every', POLL_INTERVAL_MS / 1000, 's');
  loop();
}

module.exports = { processDueFollowUps };

/* ------------------------------------------------------------------
   INTEGRATION NOTE — run in-process instead of as a separate deploy:

   In server.js, near the existing queue-processor setInterval (section
   "17. START SERVER"), add:

     const { processDueFollowUps } = require('./src/workers/followup-worker');
     setInterval(() => { processDueFollowUps().catch(e => console.error('[followup-worker]', e.message)); }, 60000);

   That reuses the same `supabase` client already created in server.js —
   just delete the createClient(...) call at the top of this file and
   accept `supabase` as a parameter instead if you go this route.
------------------------------------------------------------------- */