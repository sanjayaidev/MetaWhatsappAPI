#!/usr/bin/env bash
# apply-interactive-json-fix.sh
#
# Applies the "interactive WhatsApp JSON reply" fix to a MetaWhatsappAPI
# checkout:
#   1. src/whatsapp-interactive.js  - adds validateInteractiveObject() for
#      checking already Meta-shaped interactive JSON (buttons/list/cta_url).
#   2. src/channel-send.js          - sendChannelMessage() can now send a
#      real `type: "interactive"` payload instead of always plain text.
#   3. src/routes/leads.js          - POST /api/leads/:id/messages accepts
#      an explicit `interactive` field and auto-detects pasted interactive
#      JSON in `body`, validates it, and sends it properly.
#   4. src/routes/chatbot.js        - POST /api/chatbot/assistant-json-message
#      now prompts for Meta-valid button/list/cta_url JSON and validates the
#      AI's output before returning it.
#   5. public/crm.html              - WhatsApp reply box gets a Text /
#      Interactive JSON mode toggle; JSON assistant panel gets a Copy button.
#   6. public/dashboard.html        - assistant JSON panel uses the improved
#      backend prompt and gets a "Use in reply ->" button.
#
# Usage:
#   ./apply-interactive-json-fix.sh [path-to-repo]
#
# Defaults to ./MetaWhatsappAPI if no path is given. Must be a git checkout
# of https://github.com/sanjayaidev/MetaWhatsappAPI (or a clone of it) with
# no local changes to the files listed above.

set -euo pipefail

REPO_DIR="${1:-./MetaWhatsappAPI}"

if [ ! -d "$REPO_DIR" ]; then
  echo "Error: '$REPO_DIR' does not exist." >&2
  echo "Usage: $0 [path-to-MetaWhatsappAPI-checkout]" >&2
  exit 1
fi

cd "$REPO_DIR"

if [ ! -d ".git" ]; then
  echo "Error: '$REPO_DIR' is not a git repository. Clone the repo first:" >&2
  echo "  git clone https://github.com/sanjayaidev/MetaWhatsappAPI.git" >&2
  exit 1
fi

for f in src/whatsapp-interactive.js src/channel-send.js src/routes/leads.js src/routes/chatbot.js public/crm.html public/dashboard.html; do
  if [ ! -f "$f" ]; then
    echo "Error: expected file '$f' not found in $REPO_DIR — is this the right repo?" >&2
    exit 1
  fi
done

PATCH_FILE="$(mktemp)"
trap 'rm -f "$PATCH_FILE"' EXIT

cat > "$PATCH_FILE" << 'PATCH_EOF'
diff --git a/public/crm.html b/public/crm.html
index b344337..2b01802 100644
--- a/public/crm.html
+++ b/public/crm.html
@@ -445,7 +445,19 @@ input:focus, select:focus, textarea:focus { outline: none; border-color: var(--g
 
 <div class="channel-tab-panel" id="ctab-whatsapp">
 <div class="thread" id="thread-whatsapp"></div>
-<div class="reply-box"><textarea id="reply-whatsapp" placeholder="Reply on WhatsApp…"></textarea><button class="btn btn-primary" onclick="sendChannelMessage('whatsapp')">Send</button></div>
+<div class="reply-mode-tabs" style="display:flex;gap:6px;margin:8px 0 4px;">
+<button type="button" class="btn btn-ghost btn-xs reply-mode-tab active" data-mode="text" onclick="setWhatsappReplyMode('text')">💬 Text</button>
+<button type="button" class="btn btn-ghost btn-xs reply-mode-tab" data-mode="json" onclick="setWhatsappReplyMode('json')">🔘 Interactive JSON</button>
+</div>
+<div class="reply-box" id="reply-box-whatsapp-text">
+<textarea id="reply-whatsapp" placeholder="Reply on WhatsApp…"></textarea>
+<button class="btn btn-primary" onclick="sendChannelMessage('whatsapp')">Send</button>
+</div>
+<div class="reply-box" id="reply-box-whatsapp-json" style="display:none;flex-direction:column;">
+<textarea id="reply-whatsapp-json" style="font-family:'DM Mono',monospace;font-size:12px;" placeholder='{&quot;type&quot;:&quot;button&quot;,&quot;body&quot;:{&quot;text&quot;:&quot;Hi! How can we help?&quot;},&quot;action&quot;:{&quot;buttons&quot;:[{&quot;type&quot;:&quot;reply&quot;,&quot;reply&quot;:{&quot;id&quot;:&quot;yes&quot;,&quot;title&quot;:&quot;Yes please&quot;}}]}}'></textarea>
+<div style="font-size:11px;color:#888;margin:4px 0;">Paste or generate a button/list/cta_url interactive object (via the assistant's JSON tab) — sent as a formatted WhatsApp message, checked against Meta's limits before sending.</div>
+<button class="btn btn-primary" onclick="sendWhatsappInteractiveReply()">Send Interactive</button>
+</div>
 </div>
 <div class="channel-tab-panel" id="ctab-instagram">
 <div class="thread" id="thread-instagram"></div>
@@ -783,10 +795,54 @@ async function loadLeadMessages(id, channel) {
   el.innerHTML = data.messages.map(m => `<div class="msg-bubble msg-${m.direction}">${escapeHtml(m.body)}<div class="msg-time">${timeAgo(m.created_at)}</div></div>`).join('');
   el.scrollTop = el.scrollHeight;
 }
+function setWhatsappReplyMode(mode) {
+  document.querySelectorAll('#ctab-whatsapp .reply-mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
+  document.getElementById('reply-box-whatsapp-text').style.display = mode === 'text' ? 'flex' : 'none';
+  document.getElementById('reply-box-whatsapp-json').style.display = mode === 'json' ? 'flex' : 'none';
+}
+
+// Explicit "Interactive JSON" mode send: always sends via { interactive },
+// never falls back to plain text, so a malformed paste fails loudly here
+// instead of silently going out as literal JSON text.
+async function sendWhatsappInteractiveReply() {
+  const box = document.getElementById('reply-whatsapp-json');
+  const raw = box.value.trim();
+  if (!raw) { showToast('Paste an interactive JSON object first', true); return; }
+  let interactive;
+  try {
+    interactive = JSON.parse(raw);
+  } catch (e) {
+    showToast('That is not valid JSON', true);
+    return;
+  }
+  if (interactive && typeof interactive.interactive === 'object') interactive = interactive.interactive;
+
+  const data = await apiCall(`/api/leads/${currentLeadId}/messages`, 'POST', { channel: 'whatsapp', interactive });
+  if (data.error) { showToast('Failed to send: ' + data.error, true); return; }
+  box.value = ''; loadLeadMessages(currentLeadId, 'whatsapp'); loadLeadTimeline(currentLeadId);
+  showToast('✓ Interactive message sent');
+}
+
 async function sendChannelMessage(channel) {
   const box = document.getElementById('reply-' + channel);
   const body = box.value.trim(); if (!body) return;
-  const data = await apiCall(`/api/leads/${currentLeadId}/messages`, 'POST', { channel, body });
+
+  // If the box holds a pasted WhatsApp interactive JSON object (buttons/list/
+  // cta_url — e.g. copied from the assistant's "Generate JSON" tab), send it
+  // as a real interactive message so the contact sees tappable buttons/a list
+  // instead of the raw JSON text. Plain text falls through unchanged.
+  const payload = { channel, body };
+  if (channel === 'whatsapp' && body.startsWith('{')) {
+    try {
+      const parsed = JSON.parse(body);
+      const candidate = parsed && typeof parsed.interactive === 'object' ? parsed.interactive : parsed;
+      if (candidate && typeof candidate === 'object' && ['button', 'list', 'cta_url'].includes(candidate.type)) {
+        payload.interactive = candidate;
+      }
+    } catch (e) { /* not JSON — send as plain text */ }
+  }
+
+  const data = await apiCall(`/api/leads/${currentLeadId}/messages`, 'POST', payload);
   if (data.error) { showToast('Failed to send: ' + data.error, true); return; }
   box.value = ''; loadLeadMessages(currentLeadId, channel); loadLeadTimeline(currentLeadId);
 }
@@ -1811,10 +1867,12 @@ async function sendAssistantJsonMessage() {
       conversation_history: assistantConversationHistory.filter(m => m.role !== 'system')
     });
     
-    let replyText = data.reply || 'Failed to generate JSON template.';
+    let replyText = data.reply || data.error || 'Failed to generate JSON template.';
     try {
-      const parsed = JSON.parse(replyText);
-      replyText = '<pre style="background:var(--bg2);padding:8px;border-radius:8px;overflow-x:auto;font-size:11px;">' + escapeHtml(JSON.stringify(parsed, null, 2)) + '</pre>';
+      const parsed = data.interactive || JSON.parse(replyText);
+      const jsonStr = JSON.stringify(parsed, null, 2);
+      replyText = '<pre style="background:var(--bg2);padding:8px;border-radius:8px;overflow-x:auto;font-size:11px;">' + escapeHtml(jsonStr) + '</pre>'
+        + '<button class="btn btn-ghost btn-xs" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent);showToast(\'Copied — paste into the WhatsApp reply box to send\')">📋 Copy</button>';
     } catch(e) {}
     
     // Add AI response to history and UI
diff --git a/public/dashboard.html b/public/dashboard.html
index 0f11ae3..88a2b35 100644
--- a/public/dashboard.html
+++ b/public/dashboard.html
@@ -1511,6 +1511,18 @@ function openReplyModal(phone, originalMessage) {
   document.getElementById('replyModal').classList.add('open');
 }
 
+// Pulls JSON text out of the assistant's rendered <pre> and drops it into the
+// reply modal's JSON tab (opening the modal in JSON mode if it's already open
+// for a lead), so a generated button/list/cta_url message can be sent as-is.
+function useGeneratedJsonInReply(preId) {
+  const pre = document.getElementById(preId);
+  if (!pre) return;
+  if (!replyTargetPhone) { showToast('Open a reply to a contact first, then use this JSON', true); return; }
+  document.getElementById('replyJsonInput').value = pre.textContent;
+  setReplyMode('json');
+  showToast('Loaded into the reply box — review, then hit Send');
+}
+
 async function sendReply() {
   if (!replyTargetPhone) return;
   const btn = document.getElementById('replySendBtn');
@@ -1863,20 +1875,23 @@ async function sendAssistantJsonMessage() {
   // Save history
   await saveAssistantHistory();
   
-  const systemPrompt = 'You are a JSON template generator. Return ONLY valid JSON. No explanations, no markdown, no extra text. Generate a message template based on the user request.';
-  
+  // No system_prompt override here — leave it unset so the backend uses its
+  // default, which spells out Meta's actual button/list/cta_url JSON shapes
+  // and limits (see DEFAULT_JSON_SYSTEM_PROMPT in src/routes/chatbot.js),
+  // and the response is validated against those limits before coming back.
   try {
     const data = await apiCall('/api/chatbot/assistant-json-message', 'POST', { 
-      message: msg, 
-      system_prompt: systemPrompt,
+      message: msg,
       conversation_history: assistantConversationHistory.filter(m => m.role !== 'system')
     });
     
-    let replyText = data.reply || 'Failed to generate JSON template.';
-    try {
-      const parsed = JSON.parse(replyText);
-      replyText = '<pre style="background:var(--bg2);padding:8px;border-radius:8px;overflow-x:auto;font-size:11px;">' + escapeHtml(JSON.stringify(parsed, null, 2)) + '</pre>';
-    } catch(e) {}
+    let replyText = data.reply || data.error || 'Failed to generate JSON template.';
+    if (data.interactive) {
+      const jsonStr = JSON.stringify(data.interactive, null, 2);
+      const id = 'json_' + Date.now();
+      replyText = '<pre id="' + id + '" style="background:var(--bg2);padding:8px;border-radius:8px;overflow-x:auto;font-size:11px;">' + escapeHtml(jsonStr) + '</pre>'
+        + '<button class="btn btn-ghost btn-xs" onclick="useGeneratedJsonInReply(\'' + id + '\')">Use in reply →</button>';
+    }
     
     // Add AI response to history and UI
     assistantConversationHistory.push({ role: 'assistant', content: replyText });
diff --git a/src/channel-send.js b/src/channel-send.js
index a8d6686..5e32ad9 100644
--- a/src/channel-send.js
+++ b/src/channel-send.js
@@ -80,7 +80,12 @@ module.exports = function createChannelSender({ supabase, decryptToken, encryptT
   // anything outside the 24h customer-service window) — free text will be
   // rejected by Meta outside that window. `body` is still passed for logging/
   // CRM display (a human-readable rendered preview of what was sent).
-  return async function sendChannelMessage({ lead, channel, body, isAutomation = false, template = null }) {
+  //
+  // `interactive`, when provided for the whatsapp channel, sends a proper
+  // Meta "interactive" object (buttons/list/cta_url — see whatsapp-interactive.js)
+  // instead of dumping that JSON as literal text. Takes priority over `body`
+  // but not over `template` (a template send always wins if both are passed).
+  return async function sendChannelMessage({ lead, channel, body, isAutomation = false, template = null, interactive = null }) {
     let status = 'sent';
     let externalId = null;
     let sendError = null;
@@ -98,6 +103,8 @@ module.exports = function createChannelSender({ supabase, decryptToken, encryptT
 
           const payload = template
             ? { messaging_product: 'whatsapp', to: lead.phone, type: 'template', template }
+            : interactive
+            ? { messaging_product: 'whatsapp', to: lead.phone, type: 'interactive', interactive }
             : { messaging_product: 'whatsapp', to: lead.phone, type: 'text', text: { body } };
 
           const result = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`, {
diff --git a/src/routes/chatbot.js b/src/routes/chatbot.js
index a223374..b11070b 100644
--- a/src/routes/chatbot.js
+++ b/src/routes/chatbot.js
@@ -4,6 +4,30 @@
 const express = require('express');
 const crypto = require('crypto');
 const { generateReply: aiGenerateReply, DEFAULT_MODEL } = require('./ai-chat');
+const { validateInteractiveObject, WhatsAppValidationError } = require('../whatsapp-interactive');
+
+// Default system prompt for /chatbot/assistant-json-message. Spells out the
+// exact shapes Meta's WhatsApp Cloud API accepts for a free-form interactive
+// message (button / list / cta_url), including the same limits enforced by
+// whatsapp-interactive.js's validateTemplateConfig() — so the AI's output is
+// actually sendable, not just "some JSON".
+const DEFAULT_JSON_SYSTEM_PROMPT = [
+  'You generate WhatsApp Cloud API interactive message JSON for a business.',
+  'Return ONLY a single raw JSON object — no markdown code fences, no explanation, no text before or after it.',
+  'The object must be a valid WhatsApp "interactive" object with exactly one "type": "button", "list", or "cta_url". Pick whichever best fits the request (buttons for a few choices, list for many options, cta_url to send a link).',
+  '',
+  'type "button" shape: { "type": "button", "body": { "text": "..." }, "action": { "buttons": [ { "type": "reply", "reply": { "id": "...", "title": "..." } } ] } }',
+  '- 1 to 3 buttons. Each button title <= 20 characters, no emoji. Each button needs a unique short "id" (e.g. "opt_1").',
+  '',
+  'type "list" shape: { "type": "list", "body": { "text": "..." }, "action": { "button": "...", "sections": [ { "title": "...", "rows": [ { "id": "...", "title": "...", "description": "..." } ] } ] } }',
+  '- "action.button" (the label that opens the list) <= 20 characters. Section "title" <= 24 characters. Row "title" <= 24 characters. Row "description" is optional, <= 72 characters. Max 10 rows total across all sections combined.',
+  '',
+  'type "cta_url" shape: { "type": "cta_url", "body": { "text": "..." }, "action": { "name": "cta_url", "parameters": { "display_text": "...", "url": "..." } } }',
+  '- "display_text" <= 20 characters. "url" must be a full https:// link.',
+  '',
+  'Any of the three may optionally include "header": { "type": "text", "text": "..." } and/or "footer": { "text": "..." }.',
+  'Do not invent other message types, and do not wrap the object in an extra "interactive" or "messaging_product" key — return the interactive object itself.',
+].join('\n');
 
 module.exports = function chatbotRouter(deps) {
   const { supabase, generateReply, verifyUser } = deps;
@@ -109,24 +133,45 @@ module.exports = function chatbotRouter(deps) {
     }
   });
 
-  // POST /api/chatbot/assistant-json-message — JSON template generation mode
+  // POST /api/chatbot/assistant-json-message — JSON template generation mode.
+  // Returns { reply, interactive } where `interactive` is the parsed, Meta-
+  // validated object — ready to hand straight to /api/leads/:id/messages or
+  // /api/messages/reply-interactive as { interactive } / { raw_interactive }.
   router.post('/chatbot/assistant-json-message', verifyUser, async (req, res) => {
     const { message, system_prompt } = req.body || {};
     if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
 
-    const { data: config } = await supabase.from('wb_chatbot_config').select('*').eq('user_id', req.user.id).eq('type', 'dashboard_assistant').single();
-    
-    // Use provided system prompt or default to JSON-only mode
-    let systemPrompt = system_prompt || 'You are a JSON template generator. Return ONLY valid JSON. No explanations, no markdown, no extra text.';
-    
+    // Use provided system prompt or default to Meta-valid interactive JSON mode
+    let systemPrompt = system_prompt || DEFAULT_JSON_SYSTEM_PROMPT;
+
     try {
       // Use Mistral Small 4 119B as the default model for chatbot
-      const reply = await aiGenerateReply({ 
+      const raw = await aiGenerateReply({ 
         model: 'mistralai/mistral-small-4-119b-2603',
         systemPrompt, 
         userText: message.trim() 
       });
-      res.json({ reply });
+
+      // Strip accidental markdown fences (models sometimes add them despite instructions).
+      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
+
+      let interactive;
+      try {
+        interactive = JSON.parse(cleaned);
+      } catch (e) {
+        return res.status(502).json({ error: 'AI did not return valid JSON. Try rephrasing your request.', reply: raw });
+      }
+
+      // Never hand back "ready to send" JSON without checking it against Meta's
+      // real limits first — same guard interactive-templates.js uses for its
+      // AI customize-template flow.
+      try {
+        validateInteractiveObject(interactive);
+      } catch (err) {
+        return res.status(502).json({ error: `AI JSON does not match WhatsApp's format: ${err.message}`, reply: cleaned });
+      }
+
+      res.json({ reply: JSON.stringify(interactive, null, 2), interactive });
     } catch (err) {
       console.error('Assistant JSON message error:', err);
       res.status(500).json({ error: err.message });
diff --git a/src/routes/leads.js b/src/routes/leads.js
index 9aa8e75..6f043db 100644
--- a/src/routes/leads.js
+++ b/src/routes/leads.js
@@ -6,6 +6,7 @@
 const express = require('express');
 
 const createChannelSender = require('../channel-send');
+const { validateInteractiveObject, WhatsAppValidationError } = require('../whatsapp-interactive');
 
 module.exports = function leadsRouter(deps) {
   const { supabase } = deps;
@@ -131,16 +132,54 @@ module.exports = function leadsRouter(deps) {
   });
 
   // POST /api/leads/:id/messages — send an outbound message on a given channel
+  //
+  // `body` is normally free text. But it also doubles as the paste target for
+  // WhatsApp interactive JSON (buttons/list/cta_url) copied out of the AI
+  // assistant's "Generate JSON" tab or Meta's docs — previously that JSON got
+  // sent to Meta as literal `type: "text"` body, so the contact saw the raw
+  // JSON string instead of tappable buttons/a list. Now: if `body` parses as
+  // JSON shaped like a WhatsApp interactive object (or `{ interactive: {...} }`),
+  // or an explicit `interactive` field is passed, it's validated against
+  // Meta's real limits and sent as a proper `type: "interactive"` message.
   router.post('/:id/messages', async (req, res) => {
-    const { channel, body } = req.body || {};
-    if (!channel || !body?.trim()) return res.status(400).json({ error: 'channel and body are required' });
+    const { channel, body, interactive: explicitInteractive } = req.body || {};
+    if (!channel || (!body?.trim() && !explicitInteractive)) {
+      return res.status(400).json({ error: 'channel and body (or interactive) are required' });
+    }
 
     const { data: lead } = await supabase.from('wb_leads').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
     if (!lead) return res.status(404).json({ error: 'Lead not found' });
     lead.user_id = req.user.id; // sender needs this to look up the right wa_accounts row
 
+    const trimmedBody = body ? body.trim() : '';
+    let interactive = explicitInteractive || null;
+
+    if (!interactive && channel === 'whatsapp' && trimmedBody.startsWith('{')) {
+      try {
+        const parsed = JSON.parse(trimmedBody);
+        const candidate = parsed && typeof parsed.interactive === 'object' ? parsed.interactive : parsed;
+        if (candidate && typeof candidate === 'object' && ['button', 'list', 'cta_url'].includes(candidate.type)) {
+          interactive = candidate;
+        }
+      } catch (_) {
+        // Not JSON (or not interactive-shaped) — falls through and sends as plain text, as before.
+      }
+    }
+
+    if (interactive) {
+      try {
+        validateInteractiveObject(interactive);
+      } catch (err) {
+        const status = err instanceof WhatsAppValidationError ? 400 : 500;
+        return res.status(status).json({ error: `Interactive JSON failed WhatsApp validation: ${err.message}` });
+      }
+    }
+
+    // Store a human-readable preview in the CRM thread rather than the raw JSON blob.
+    const storedBody = interactive ? (interactive.body?.text || `[Interactive ${interactive.type} message]`) : trimmedBody;
+
     try {
-      const msg = await sendChannelMessage({ lead, channel, body: body.trim(), isAutomation: false });
+      const msg = await sendChannelMessage({ lead, channel, body: storedBody, interactive, isAutomation: false });
       res.json({ success: true, message: msg });
     } catch (err) {
       res.status(502).json({ error: err.message, message: err.message /* channel-send attaches the row here too */ });
diff --git a/src/whatsapp-interactive.js b/src/whatsapp-interactive.js
index 714b18e..e1a7f40 100644
--- a/src/whatsapp-interactive.js
+++ b/src/whatsapp-interactive.js
@@ -77,6 +77,52 @@ function validateRawConfig(cfg) {
   }
 }
 
+// Validates an already Meta-shaped `interactive` object directly (the actual
+// wire format, e.g. { type: "button", action: { buttons: [{ type: "reply",
+// reply: { id, title } }] } } — as opposed to the flatter builder `cfg` shapes
+// validateButtonConfig/validateListConfig/validateCtaUrlConfig above expect).
+// Used to check AI-generated or hand-pasted interactive JSON before it's
+// treated as "ready to send". Throws WhatsAppValidationError.
+function validateInteractiveObject(obj) {
+  if (!obj || typeof obj !== 'object') throw new WhatsAppValidationError('Interactive message must be a JSON object.');
+  if (!obj.body || !obj.body.text || !obj.body.text.trim()) throw new WhatsAppValidationError('Interactive message needs a body.text.');
+
+  if (obj.type === 'button') {
+    const buttons = obj.action?.buttons || [];
+    if (buttons.length === 0) throw new WhatsAppValidationError('Button message needs at least 1 button.');
+    if (buttons.length > 3) throw new WhatsAppValidationError(`Button message supports max 3 buttons, got ${buttons.length}.`);
+    const seenIds = new Set();
+    for (const btn of buttons) {
+      const id = btn.reply?.id, title = btn.reply?.title;
+      if (!id || !title) throw new WhatsAppValidationError('Each button needs action.buttons[].reply.id and .title.');
+      if (title.length > 20) throw new WhatsAppValidationError(`Button title "${title}" exceeds 20 characters.`);
+      if (EMOJI_REGEX.test(title)) throw new WhatsAppValidationError(`Button title "${title}" contains an emoji (not supported).`);
+      if (seenIds.has(id)) throw new WhatsAppValidationError(`Duplicate button id "${id}".`);
+      seenIds.add(id);
+    }
+  } else if (obj.type === 'list') {
+    const sections = obj.action?.sections || [];
+    const totalRows = sections.reduce((sum, s) => sum + (s.rows || []).length, 0);
+    if (totalRows === 0) throw new WhatsAppValidationError('List message needs at least 1 row.');
+    if (totalRows > 10) throw new WhatsAppValidationError(`List message supports max 10 rows total, got ${totalRows}.`);
+    if (!obj.action?.button || obj.action.button.length > 20) throw new WhatsAppValidationError('List action.button label is required and must be <= 20 characters.');
+    for (const section of sections) {
+      if (!section.title || section.title.length > 24) throw new WhatsAppValidationError(`Section title "${section.title}" is required and must be <= 24 characters.`);
+      for (const row of section.rows || []) {
+        if (!row.id || !row.title) throw new WhatsAppValidationError('Each row needs an id and a title.');
+        if (row.title.length > 24) throw new WhatsAppValidationError(`Row title "${row.title}" exceeds 24 characters.`);
+        if (row.description && row.description.length > 72) throw new WhatsAppValidationError(`Row description for "${row.title}" exceeds 72 characters.`);
+      }
+    }
+  } else if (obj.type === 'cta_url') {
+    const params = obj.action?.parameters || {};
+    if (!params.display_text || params.display_text.length > 20) throw new WhatsAppValidationError('cta_url action.parameters.display_text is required and must be <= 20 characters.');
+    if (!params.url || !params.url.trim()) throw new WhatsAppValidationError('cta_url action.parameters.url is required.');
+  } else {
+    throw new WhatsAppValidationError(`Unsupported interactive type "${obj.type}". Must be "button", "list", or "cta_url".`);
+  }
+}
+
 /** Validates a template config object against Meta's limits for its `kind`. Throws WhatsAppValidationError. */
 function validateTemplateConfig(kind, cfg) {
   if (kind === 'text') {
@@ -185,5 +231,6 @@ module.exports = {
   renderTemplate,
   validateRecipient,
   validateTemplateConfig,
+  validateInteractiveObject,
   buildMessagePayload,
 };
PATCH_EOF

echo "Checking patch applies cleanly (dry run)..."
if ! git apply --check "$PATCH_FILE" 2>/tmp/patch_check_err; then
  echo "Error: patch does not apply cleanly. This usually means the files" >&2
  echo "have already been modified, or the repo has diverged from the" >&2
  echo "version this patch was generated against. Details:" >&2
  cat /tmp/patch_check_err >&2
  exit 1
fi

echo "Applying patch..."
git apply "$PATCH_FILE"

echo "Verifying JS syntax..."
for f in src/whatsapp-interactive.js src/channel-send.js src/routes/leads.js src/routes/chatbot.js; do
  node -c "$f"
  echo "  OK  $f"
done

echo ""
echo "Done. Changed files:"
git diff --stat HEAD

echo ""
echo "Next steps:"
echo "  1. Review the diff:  git -C \"$REPO_DIR\" diff"
echo "  2. Restart your server so the route/module changes take effect."
echo "  3. In the CRM, open a lead -> WhatsApp tab -> 'Interactive JSON' toggle"
echo "     to send a button/list/cta_url message, or paste one into the plain"
echo "     text box (it now auto-detects and sends it formatted)."