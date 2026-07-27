// AI Chat endpoint using NVIDIA's OpenAI-compatible API
// No aider needed - just direct API calls

const express = require('express');
const router = express.Router();

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// ============================================================
// ALL AVAILABLE AI MODELS - Working text models only (tested 2026-07-27)
// Default model: meta/llama-3.1-70b-instruct (fast, capable, multilingual)
// ============================================================
const ALLOWED_MODELS = [
  // Meta models - Text only
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-3b-instruct',
  'meta/llama-3.2-90b-vision-instruct',
  
  // Mistral models
  'mistralai/mistral-medium-3.5-128b',
  
  // NVIDIA text models (excluding safety/content moderation)
  'nvidia/ising-calibration-1-35b-a3b',
  'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'nvidia/nemotron-3-nano-30b-a3b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-nano-12b-v2-vl',
];

// Models with excellent multilingual/regional language support
const MULTILINGUAL_MODELS = new Set([
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'mistralai/mistral-medium-3.5-128b',
]);

// Default model - Best performing text model (322ms response time)
const DEFAULT_MODEL = 'meta/llama-3.1-70b-instruct';

// Models that support vision (file attachments)
const VISION_MODELS = new Set([
  'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-90b-vision-instruct',
  'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
  'nvidia/nemotron-nano-12b-v2-vl',
]);

// Fast models for quick responses
const FAST_MODELS = new Set([
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-3b-instruct',
  'nvidia/ising-calibration-1-35b-a3b',
  'nvidia/nemotron-3-nano-30b-a3b',
]);

function isAllowedModel(modelId) {
  return ALLOWED_MODELS.includes(modelId);
}

// Reusable helper: send a chat request to NVIDIA with optional conversation history
// and return the assistant's reply text. Used by the webhook auto-reply flow
// as well as anything else that needs an AI response.
async function generateReply({ model, systemPrompt, userText, temperature = 0.7, max_tokens = 512, conversation_history = [], response_format = null }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not configured');

  const chosenModel = isAllowedModel(model) ? model : DEFAULT_MODEL;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  
  // Add conversation history if provided
  if (Array.isArray(conversation_history) && conversation_history.length > 0) {
    messages.push(...conversation_history);
  }
  
  // Add current user message
  messages.push({ role: 'user', content: userText });

  const payload = {
    model: chosenModel,
    messages,
    temperature,
    max_tokens,
    top_p: 1,
    stream: false,
  };
  // Optional OpenAI-style response_format (e.g. { type: 'json_object' }) —
  // NVIDIA's endpoint is OpenAI-compatible and most instruct models honor
  // this, constraining sampling so the output is syntactically valid JSON
  // instead of just being asked nicely in the prompt.
  if (response_format) payload.response_format = response_format;

  const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `NVIDIA API error (${response.status})`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
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
  const apiKey = process.env.NVIDIA_API_KEY;
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

    const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
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
