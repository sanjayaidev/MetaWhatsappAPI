// src/services/bot-engine.js
//
// Call from server.js's handleIncomingMessage(), right after the inbound
// message is stored and before the existing "auto_reply" AI/template branch
// (see integration note at the bottom of this file). If a rule matches,
// send its result instead of falling through to the generic AI auto-reply.
//
//   const { matchRule } = require('./src/services/bot-engine');
//   const match = await matchRule({ supabase }, { userId: waAccount.user_id, phone: msg.from, text: msg.text?.body, replyOptionId });
//   if (match) { /* send match.templateId or run match.aiPrompt, then return */ }

function matchesKeyword(text, keywords, matchType) {
  const norm = (text || '').toLowerCase().trim();
  return (keywords || []).some(kw => {
    const k = kw.toLowerCase().trim();
    if (matchType === 'exact') return norm === k;
    if (matchType === 'fuzzy') return norm.includes(k) || fuzzyClose(norm, k);
    return norm.includes(k); // contains (default)
  });
}
function fuzzyClose(text, keyword) {
  return text.split(/\s+/).some(word => editDistance(word, keyword) <= 1);
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

function evaluateCondition(cond, ctx) {
  const val = ctx[cond.variable];
  if (val === undefined) return false;
  switch (cond.operator) {
    case 'equals': return String(val) === String(cond.value);
    case 'contains': return String(val).includes(cond.value);
    case 'gt': return Number(val) > Number(cond.value);
    case 'lt': return Number(val) < Number(cond.value);
    default: return false;
  }
}

async function matchRule({ supabase }, { userId, phone, text, replyOptionId }) {
  // Any pending follow-up for this contact is satisfied by them writing in again.
  await supabase
    .from('wb_bot_conversation_state')
    .update({ replied_since_trigger: true, last_inbound_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('phone', phone)
    .eq('follow_up_sent', false);

  const { data: rules, error } = await supabase
    .from('wb_bot_rules')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true);
  if (error) { console.error('[bot-engine] failed to load rules', error); return null; }

  const rule = (rules || []).find(r => matchesKeyword(text, r.keywords, r.match_type));
  if (!rule) return null;

  const ctx = { reply_option: replyOptionId };
  let templateId = rule.action_template_id;
  if (rule.action_type === 'template') {
    const matchedCond = (rule.conditions || []).find(c => evaluateCondition(c, ctx));
    templateId = matchedCond ? (matchedCond.template_id || matchedCond.templateId)
                              : (rule.else_template_id || rule.action_template_id);
  }

  const followUp = rule.follow_up || {};
  if (followUp.enabled) {
    // Enforce strict maximum follow-up time of 20 hours
    const followUpHours = Math.min(followUp.hours || 4, 20);
    const dueAt = new Date(Date.now() + followUpHours * 3600 * 1000).toISOString();
    const { error: insertErr } = await supabase.from('wb_bot_conversation_state').insert({
      user_id: userId, phone, rule_id: rule.id,
      last_inbound_at: new Date().toISOString(), follow_up_due_at: dueAt
    });
    if (insertErr) console.error('[bot-engine] failed to schedule follow-up', insertErr);
  }

  return {
    ruleId: rule.id,
    actionType: rule.action_type,      // 'template' | 'ai' | 'ecom_catalog'
    templateId,                        // wb_bot_templates.id, when actionType === 'template'
    aiPrompt: rule.ai_prompt,
    aiFallback: rule.ai_fallback,
    // ecom_catalog: action_config.product_ids (uuid[]) selects which products
    // to show. Empty/absent = show all active products (server.js caps at 10).
    actionConfig: rule.action_config || {},
  };
}

module.exports = { matchRule };

/* ------------------------------------------------------------------
   INTEGRATION NOTE for server.js's handleIncomingMessage():

   Insert this right after the inbound message is stored (after the
   `wb_inbound_messages` insert), and before the
   `if (msg.type !== 'text' || !msg.text?.body) return;` line:

     if (msg.type === 'text' && msg.text?.body) {
       const { matchRule } = require('./src/services/bot-engine');
       const match = await matchRule({ supabase }, {
         userId: waAccount.user_id,
         phone: msg.from,
         text: msg.text.body,
         replyOptionId: msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id
       });
       if (match) {
         if (match.actionType === 'template' && match.templateId) {
           const { data: tpl } = await supabase
             .from('wb_bot_templates').select('payload').eq('id', match.templateId).single();
           if (tpl) {
             // reuse buildMessagePayload from src/whatsapp-interactive.js if the
             // payload shape matches your `kind/config` format, or send tpl.payload
             // directly if you keep it in raw Graph API shape.
             const plainToken = decryptToken(waAccount.access_token);
             await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
               body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.from, ...tpl.payload })
             });
           }
         } else if (match.actionType === 'ai') {
           const replyText = await generateReply({
             model: DEFAULT_AI_MODEL,
             systemPrompt: match.aiPrompt || 'You are a helpful business assistant.',
             userText: msg.text.body
           }).catch(() => match.aiFallback);
           if (replyText) {
             const plainToken = decryptToken(waAccount.access_token);
             await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
               body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.from, type: 'text', text: { body: replyText } })
             });
           }
         }
         return; // a bot-builder rule handled this — skip the generic auto_reply settings below
       }
     }
------------------------------------------------------------------- */