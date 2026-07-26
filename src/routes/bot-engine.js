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

const fetch = require('node-fetch');

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

// A rule's action_config.sheet_lookup (set per-rule from chatbot-builder.html's
// action editor) points at one Google Sheet + lookup/return column pair. Because
// it lives on action_config (already a free-form JSON column on wb_bot_rules),
// each rule gets its own independent lookup — that's what gives "multi lookup"
// support: rule A can look up prices in one sheet while rule B looks up order
// status in a completely different sheet, each triggered by its own keywords.
//
// Matching strategy: the incoming message text is compared against every data
// row's lookup-column cell (case-insensitive, both directions with `contains`
// so "price for classic tee" matches a lookup cell of "classic tee"). `exact`
// requires the whole (trimmed) message to equal the cell.
async function performSheetLookup({ getValidGoogleAccessToken, fetch }, userId, lookupConfig, text) {
  const { workbookId, worksheet, lookupColumn, returnColumn, matchType } = lookupConfig || {};
  if (!workbookId || !worksheet || !lookupColumn || !returnColumn) return null;

  let accessToken;
  try {
    accessToken = await getValidGoogleAccessToken(userId);
  } catch (err) {
    console.error('[bot-engine] sheet lookup: Google auth failed:', err.message);
    return { found: false, error: err.message };
  }

  try {
    // ZZ (not Z) so sheets with >26 columns still resolve header names correctly.
    const range = encodeURIComponent(`${worksheet}!A1:ZZ`);
    const valuesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const valuesData = await valuesRes.json();
    if (!valuesRes.ok) throw new Error(valuesData.error?.message || 'Failed to fetch sheet');

    const rows = valuesData.values || [];
    if (!rows.length) return { found: false };

    const headers = rows[0];
    const norm = (s) => (s || '').toString().trim().toLowerCase();
    const lookupIdx = headers.findIndex(h => norm(h) === norm(lookupColumn));
    const returnIdx = headers.findIndex(h => norm(h) === norm(returnColumn));
    if (lookupIdx === -1 || returnIdx === -1) {
      return { found: false, error: `Column "${lookupIdx === -1 ? lookupColumn : returnColumn}" not found in sheet header row` };
    }

    const normText = norm(text);
    for (let i = 1; i < rows.length; i++) {
      const cell = norm(rows[i][lookupIdx]);
      if (!cell) continue;
      const isMatch = matchType === 'exact' ? normText === cell : (normText.includes(cell) || cell.includes(normText));
      if (isMatch) return { found: true, value: rows[i][returnIdx] ?? '', matchedRow: rows[i] };
    }
    return { found: false };
  } catch (err) {
    console.error('[bot-engine] sheet lookup failed:', err.message);
    return { found: false, error: err.message };
  }
}

// A rule's action_config.knowledge_doc ({ docId, docName }, set per-rule from
// chatbot-builder.html's action editor) is a Google Doc whose plain text gets
// fed to the AI as grounding context — same per-rule pattern as sheet_lookup
// above, so different AI rules can be grounded in different docs.
// 5-minute cache keyed by docId: a doc rarely changes turn-to-turn, and this
// avoids a Docs API round trip on every single matching inbound message.
const docContentCache = new Map();
const DOC_CACHE_TTL_MS = 5 * 60 * 1000;

async function getDocContent({ getValidGoogleAccessToken, fetch }, userId, docId) {
  if (!docId) return null;
  const cached = docContentCache.get(docId);
  if (cached && (Date.now() - cached.fetchedAt) < DOC_CACHE_TTL_MS) return cached.content;

  let accessToken;
  try {
    accessToken = await getValidGoogleAccessToken(userId);
  } catch (err) {
    console.error('[bot-engine] doc lookup: Google auth failed:', err.message);
    return null;
  }

  try {
    const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const docData = await docRes.json();
    if (!docRes.ok) throw new Error(docData.error?.message || 'Failed to fetch document');

    // Same flattening as src/routes/flows.js's /oauth/google/doc-content route.
    const content = (docData.body?.content || [])
      .map(block => (block.paragraph?.elements || [])
        .map(el => el.textRun?.content || '')
        .join(''))
      .join('')
      .trim()
      .slice(0, 8000); // keep the system prompt from ballooning on a huge doc

    docContentCache.set(docId, { content, fetchedAt: Date.now() });
    return content;
  } catch (err) {
    console.error('[bot-engine] doc lookup failed:', err.message);
    return null;
  }
}

async function matchRule({ supabase, getValidGoogleAccessToken }, { userId, phone, text, replyOptionId }) {
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
  let sheetLookupResult = null;
  const sheetLookupConfig = rule.action_config?.sheet_lookup;
  if (sheetLookupConfig?.workbookId && getValidGoogleAccessToken) {
    sheetLookupResult = await performSheetLookup({ getValidGoogleAccessToken, fetch }, userId, sheetLookupConfig, text);
    // '__not_found__' lets a condition explicitly branch on "no matching row"
    // (e.g. a condition of variable sheet_lookup / equals __not_found__) without
    // that string colliding with a real, arbitrary sheet cell value.
    ctx.sheet_lookup = sheetLookupResult?.found ? sheetLookupResult.value : '__not_found__';
  }

  let docContent = null;
  const docConfig = rule.action_config?.knowledge_doc;
  if (rule.action_type === 'ai' && docConfig?.docId && getValidGoogleAccessToken) {
    docContent = await getDocContent({ getValidGoogleAccessToken, fetch }, userId, docConfig.docId);
  }

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
    // { found, value, matchedRow? } when this rule has a sheet_lookup configured
    // and getValidGoogleAccessToken was supplied, otherwise null. server.js uses
    // this to inject the looked-up value into the AI system prompt (actionType
    // 'ai') or substitute a {{sheet_lookup}} placeholder in a template's text
    // (actionType 'template'). It's also already mirrored onto ctx.sheet_lookup
    // above, so a rule's own conditions can branch on it too.
    sheetLookupResult,
    // Plain text of action_config.knowledge_doc's Google Doc, when this is an
    // 'ai' rule with a doc configured — server.js appends it to the AI system
    // prompt as grounding, same idea as sheetLookupResult but for free-form docs.
    docContent,
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