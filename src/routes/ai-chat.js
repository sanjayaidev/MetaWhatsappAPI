// AI Chat endpoint using NVIDIA's OpenAI-compatible API
// No aider needed - just direct API calls

const express = require('express');
const router = express.Router();

const core = require('../ai-core');
const { ALLOWED_MODELS, DEFAULT_MODEL, AI_BASE_URL, isAllowedModel, getApiKey } = core;

// ============================================================
// Models are configured in src/ai-core.js (the three NVIDIA models that
// passed a live test). Override without a deploy via env AI_MODELS.
// ============================================================

// Models with good multilingual/Hinglish output (tested)
const MULTILINGUAL_MODELS = new Set(ALLOWED_MODELS);

// Models that accept image attachments
const VISION_MODELS = new Set(
  ALLOWED_MODELS.filter((m) => /vision|-vl|vl-|omni/i.test(m))
);

// Fast models for quick responses (first two in the list)
const FAST_MODELS = new Set(ALLOWED_MODELS.slice(0, 2));


// Reusable helper: send a chat request and return the assistant's reply text.
// Used by the webhook auto-reply flow and anything else that needs an AI response.
// Has an 8s per-model timeout and falls back through ALLOWED_MODELS automatically.
async function generateReply({ model, systemPrompt, userText, temperature = 0.7, max_tokens = 1024, conversation_history = [], response_format = null }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (Array.isArray(conversation_history) && conversation_history.length > 0) {
    messages.push(...conversation_history);
  }
  messages.push({ role: 'user', content: userText });

  const out = await core.chat({ model, messages, temperature, max_tokens, response_format });
  return out.text;
}

// GET /api/ai/models - List available models
router.get('/models', (req, res) => {
  const byProvider = {};
  ALLOWED_MODELS.forEach((modelId) => {
    const parts = modelId.split('/');
    const provider = parts.length > 1 ? parts[0] : 'nvidia';
    if (!byProvider[provider]) byProvider[provider] = [];
    byProvider[provider].push(modelId);
  });

  res.json({ 
    success: true,
    models: ALLOWED_MODELS, 
    by_provider: byProvider,
    vision_models: Array.from(VISION_MODELS),
    multilingual_models: Array.from(MULTILINGUAL_MODELS),
    fast_models: Array.from(FAST_MODELS),
    default_model: DEFAULT_MODEL,
    total: ALLOWED_MODELS.length
  });
});

// POST /api/ai/chat - Send chat message
router.post('/chat', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    return res.status(500).json({ error: 'NVIDIA_API_KEY not configured' });
  }

  const {
    messages,
    model = DEFAULT_MODEL,
    temperature = 0.7,
    max_tokens = 2048,
    stream = false,
  } = req.body;

  // Validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  if (!isAllowedModel(model)) {
    return res.status(403).json({
      error: `Model "${model}" not allowed.`,
      available_models: ALLOWED_MODELS,
      default_model: DEFAULT_MODEL,
    });
  }

  try {
    const payload = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature,
      max_tokens,
      top_p: 1,
      stream: Boolean(stream),
    };

    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: 'NVIDIA API error',
        details: errorData,
      });
    }

    // Streaming response
    if (stream && response.body) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.body.pipe(res);
      return;
    }

    // Non-streaming response
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('AI Chat error:', err);
    res.status(500).json({
      error: 'Failed to process chat request',
      details: err.message,
    });
  }
});

module.exports = router;
module.exports.generateReply = generateReply;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.ALLOWED_MODELS = ALLOWED_MODELS;
module.exports.VISION_MODELS = VISION_MODELS;
module.exports.FAST_MODELS = FAST_MODELS;
module.exports.MULTILINGUAL_MODELS = MULTILINGUAL_MODELS;
