// src/routes/chatbot.js — website widget + dashboard assistant config, and the
// dashboard assistant's chat endpoint (reuses the existing NVIDIA-backed
// generateReply() from src/routes/ai-chat.js rather than a second AI client).
const express = require('express');
const crypto = require('crypto');
const { generateReply: aiGenerateReply, DEFAULT_MODEL } = require('./ai-chat');
const { validateInteractiveObject, WhatsAppValidationError } = require('../whatsapp-interactive');

// Default system prompt for /chatbot/assistant-json-message. Spells out the
// exact shapes Meta's WhatsApp Cloud API accepts for a free-form interactive
// message (button / list / cta_url), including the same limits enforced by
// whatsapp-interactive.js's validateTemplateConfig() — so the AI's output is
// actually sendable, not just "some JSON".
const DEFAULT_JSON_SYSTEM_PROMPT = [
  'You generate WhatsApp Cloud API interactive message JSON for a business.',
  'Return ONLY a single raw JSON object — no markdown code fences, no explanation, no text before or after it.',
  'The object must be a valid WhatsApp "interactive" object with exactly one "type": "button", "list", or "cta_url". Pick whichever best fits the request (buttons for a few choices, list for many options, cta_url to send a link).',
  '',
  'type "button" shape: { "type": "button", "body": { "text": "..." }, "action": { "buttons": [ { "type": "reply", "reply": { "id": "...", "title": "..." } } ] } }',
  '- 1 to 3 buttons. Each button title <= 20 characters, no emoji. Each button needs a unique short "id" (e.g. "opt_1").',
  '',
  'type "list" shape: { "type": "list", "body": { "text": "..." }, "action": { "button": "...", "sections": [ { "title": "...", "rows": [ { "id": "...", "title": "...", "description": "..." } ] } ] } }',
  '- "action.button" (the label that opens the list) <= 20 characters. Section "title" <= 24 characters. Row "title" <= 24 characters. Row "description" is optional, <= 72 characters. Max 10 rows total across all sections combined.',
  '',
  'type "cta_url" shape: { "type": "cta_url", "body": { "text": "..." }, "action": { "name": "cta_url", "parameters": { "display_text": "...", "url": "..." } } }',
  '- "display_text" <= 20 characters. "url" must be a full https:// link.',
  '',
  'Any of the three may optionally include "header": { "type": "text", "text": "..." } and/or "footer": { "text": "..." }.',
  'Do not invent other message types, and do not wrap the object in an extra "interactive" or "messaging_product" key — return the interactive object itself.',
  '',
  'Worked example for type "button" with 3 options — copy this bracket structure exactly, including the closing "}" on each object inside the array before the next one starts:',
  '{"type":"button","body":{"text":"Which time works best?"},"action":{"buttons":[{"type":"reply","reply":{"id":"opt_1","title":"9 AM"}},{"type":"reply","reply":{"id":"opt_2","title":"7 PM"}},{"type":"reply","reply":{"id":"opt_3","title":"8 PM"}}]}}',
  'Before returning, mentally check that every "{" has a matching "}" and every "[" has a matching "]" — a single missing brace makes the whole message unsendable.',
].join('\n');

module.exports = function chatbotRouter(deps) {
  const { supabase, generateReply, verifyUser } = deps;
  const router = express.Router();
  
  // Cache for fetched knowledge base content (per user)
  const knowledgeCache = new Map();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Helper to fetch content from a URL
  async function fetchUrlContent(url) {
    try {
      const response = await fetch(url, { timeout: 10000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      // Strip HTML tags if it's an HTML page
      const cleaned = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return cleaned.slice(0, 8000); // Limit content length
    } catch (err) {
      console.error(`Failed to fetch ${url}:`, err.message);
      return null;
    }
  }

  // Get or refresh cached knowledge for a user
  async function getKnowledgeContent(user_id, urls) {
    const cacheKey = user_id;
    const cached = knowledgeCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      return cached.content;
    }
    
    let allContent = [];
    for (const url of urls) {
      const content = await fetchUrlContent(url);
      if (content) allContent.push(`Content from ${url}:\n${content}`);
    }
    
    const combined = allContent.join('\n\n---\n\n');
    knowledgeCache.set(cacheKey, { content: combined, timestamp: now });
    return combined;
  }

  // GET /api/chatbot-config?type=website_widget|dashboard_assistant
  router.get('/chatbot-config', verifyUser, async (req, res) => {
    const { type } = req.query;
    if (!['website_widget', 'dashboard_assistant'].includes(type)) return res.status(400).json({ error: 'invalid type' });
    const { data } = await supabase.from('wb_chatbot_config').select('*').eq('user_id', req.user.id).eq('type', type).single();
    res.json({ config: data || null });
  });

  // POST /api/chatbot-config
  router.post('/chatbot-config', verifyUser, async (req, res) => {
    const { type, system_prompt, knowledge_urls = [], active = true } = req.body || {};
    if (!['website_widget', 'dashboard_assistant'].includes(type)) return res.status(400).json({ error: 'invalid type' });

    const patch = { user_id: req.user.id, type, system_prompt, knowledge_urls: type === 'website_widget' ? knowledge_urls.slice(0, 5) : [], active, updated_at: new Date().toISOString() };
    if (type === 'website_widget') {
      const { data: existing } = await supabase.from('wb_chatbot_config').select('bot_token').eq('user_id', req.user.id).eq('type', type).single();
      patch.bot_token = existing?.bot_token || crypto.randomBytes(16).toString('hex');
    }

    const { data, error } = await supabase.from('wb_chatbot_config').upsert(patch, { onConflict: 'user_id,type' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ config: data });
  });

  // POST /api/chatbot/assistant-message — the dashboard's floating AI assistant
  router.post('/chatbot/assistant-message', verifyUser, async (req, res) => {
    const { message, conversation_history = [] } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    const { data: config } = await supabase.from('wb_chatbot_config').select('*').eq('user_id', req.user.id).eq('type', 'dashboard_assistant').single();
    
    // Default system prompt with Mistral Small 4 119B as the model context
    let systemPrompt = config?.system_prompt || 'You are a helpful CRM assistant. Help the user triage leads, draft replies, and summarize conversations.';
    
    // Add knowledge base context if available
    const knowledgeUrls = config?.knowledge_urls || [
      'https://sanjaymeher.online/marketing/wablast',
      'https://sanjaymeher.online/sanjaydev/wablast'
    ];
    
    try {
      const knowledgeContent = await getKnowledgeContent(req.user.id, knowledgeUrls);
      if (knowledgeContent) {
        systemPrompt += `\n\nUse the following knowledge base content to answer questions:\n${knowledgeContent}`;
      }
      
      // Use Mistral Small 4 119B as the default model for chatbot
      const reply = await aiGenerateReply({ 
        model: 'mistralai/mistral-small-4-119b-2603',
        systemPrompt, 
        userText: message.trim(),
        conversation_history 
      });
      res.json({ reply });
    } catch (err) {
      console.error('Assistant message error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chatbot/assistant-json-message — JSON template generation mode.
  // Returns { reply, interactive } where `interactive` is the parsed, Meta-
  // validated object — ready to hand straight to /api/leads/:id/messages or
  // /api/messages/reply-interactive as { interactive } / { raw_interactive }.
  router.post('/chatbot/assistant-json-message', verifyUser, async (req, res) => {
    const { message, system_prompt } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    // Use provided system prompt or default to Meta-valid interactive JSON mode
    let systemPrompt = system_prompt || DEFAULT_JSON_SYSTEM_PROMPT;
    const model = 'mistralai/mistral-small-4-119b-2603';

    // Try to parse+validate a generation; returns { interactive, cleaned } or
    // throws with a descriptive message (JSON syntax error or Meta-shape error).
    function parseAndValidate(raw) {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
      let interactive;
      try {
        interactive = JSON.parse(cleaned);
      } catch (e) {
        const err = new Error(`not valid JSON (${e.message})`);
        err.cleaned = cleaned;
        throw err;
      }
      try {
        validateInteractiveObject(interactive);
      } catch (e) {
        const err = new Error(`doesn't match WhatsApp's format: ${e.message}`);
        err.cleaned = cleaned;
        throw err;
      }
      return { interactive, cleaned };
    }

    try {
      // Attempt 1: ask for strict JSON-object output. response_format isn't
      // supported by every model on this provider, so if the API rejects the
      // param outright, fall back to a plain call and rely on the prompt.
      let raw;
      try {
        raw = await aiGenerateReply({ model, systemPrompt, userText: message.trim(), response_format: { type: 'json_object' } });
      } catch (e) {
        raw = await aiGenerateReply({ model, systemPrompt, userText: message.trim() });
      }

      let result;
      try {
        result = parseAndValidate(raw);
      } catch (firstErr) {
        // Attempt 2 (self-repair): show the model exactly what it produced and
        // exactly why it was rejected, and ask for a corrected object only.
        // This catches the model's own common mistake (e.g. a missing "}"
        // before the next array element) far more often than a cold retry.
        const repairPrompt = [
          'Your previous response was not valid, sendable WhatsApp interactive JSON.',
          `Error: ${firstErr.message}`,
          'Here is what you returned:',
          firstErr.cleaned || raw,
          '',
          'Return ONLY the corrected, complete JSON object — no markdown fences, no explanation. Double-check every "{" has a matching "}" before you answer.',
        ].join('\n');
        const repaired = await aiGenerateReply({ model, systemPrompt, userText: repairPrompt });
        try {
          result = parseAndValidate(repaired);
        } catch (secondErr) {
          return res.status(502).json({
            error: `AI could not produce valid WhatsApp JSON after a retry: ${secondErr.message}. Try rephrasing your request.`,
            reply: secondErr.cleaned || repaired,
          });
        }
      }

      res.json({ reply: JSON.stringify(result.interactive, null, 2), interactive: result.interactive });
    } catch (err) {
      console.error('Assistant JSON message error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chatbot/widget-message — public endpoint the embedded website widget calls (auth via bot_token).
  router.post('/chatbot/widget-message', async (req, res) => {
    const { bot_token, message, visitor } = req.body || {};
    if (!bot_token || !message?.trim()) return res.status(400).json({ error: 'bot_token and message are required' });

    const { data: config } = await supabase.from('wb_chatbot_config').select('*').eq('bot_token', bot_token).eq('type', 'website_widget').eq('active', true).single();
    if (!config) return res.status(404).json({ error: 'Invalid or inactive widget token' });

    try {
      let systemPrompt = config.system_prompt || 'You are a helpful sales assistant for this website.';
      
      // Add knowledge base context for widget too
      const knowledgeUrls = config.knowledge_urls || [
        'https://sanjaymeher.online/marketing/wablast',
        'https://sanjaymeher.online/sanjaydev/wablast'
      ];
      
      const knowledgeContent = await getKnowledgeContent(config.user_id, knowledgeUrls);
      if (knowledgeContent) {
        systemPrompt += `\n\nUse the following knowledge base content to answer questions:\n${knowledgeContent}`;
      }
      
      const reply = await aiGenerateReply({ 
        model: 'mistralai/mistral-small-4-119b-2603',
        systemPrompt, 
        userText: message.trim() 
      });

      // First message from a visitor becomes a web_chat lead.
      if (visitor?.name || visitor?.email || visitor?.phone) {
        const { data: lead } = await supabase.from('wb_leads').insert({
          user_id: config.user_id, name: visitor.name, email: visitor.email, phone: visitor.phone, primary_source: 'web_chat'
        }).select().single();
        if (lead) await supabase.from('wb_channel_messages').insert([
          { lead_id: lead.id, user_id: config.user_id, channel: 'web_chat', direction: 'in', body: message.trim() },
          { lead_id: lead.id, user_id: config.user_id, channel: 'web_chat', direction: 'out', body: reply }
        ]);
      }

      res.json({ reply });
    } catch (err) {
      console.error('Widget message error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
