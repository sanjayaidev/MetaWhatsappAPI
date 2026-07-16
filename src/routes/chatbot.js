// src/routes/chatbot.js — website widget + dashboard assistant config, and the
// dashboard assistant's chat endpoint (reuses the existing NVIDIA-backed
// generateReply() from src/routes/ai-chat.js rather than a second AI client).
const express = require('express');
const crypto = require('crypto');
const { generateReply: aiGenerateReply, DEFAULT_MODEL } = require('./ai-chat');

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
    const { message } = req.body || {};
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
        userText: message.trim() 
      });
      res.json({ reply });
    } catch (err) {
      console.error('Assistant message error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chatbot/assistant-json-message — JSON template generation mode
  router.post('/chatbot/assistant-json-message', verifyUser, async (req, res) => {
    const { message, system_prompt } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    const { data: config } = await supabase.from('wb_chatbot_config').select('*').eq('user_id', req.user.id).eq('type', 'dashboard_assistant').single();
    
    // Use provided system prompt or default to JSON-only mode
    let systemPrompt = system_prompt || 'You are a JSON template generator. Return ONLY valid JSON. No explanations, no markdown, no extra text.';
    
    try {
      // Use Mistral Small 4 119B as the default model for chatbot
      const reply = await aiGenerateReply({ 
        model: 'mistralai/mistral-small-4-119b-2603',
        systemPrompt, 
        userText: message.trim() 
      });
      res.json({ reply });
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
