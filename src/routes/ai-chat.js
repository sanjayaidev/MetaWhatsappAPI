// AI Chat endpoint using NVIDIA's OpenAI-compatible API
// No aider needed - just direct API calls

const express = require('express');
const router = express.Router();

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// Allowed models from NVIDIA
const ALLOWED_MODELS = [
  'mistralai/mistral-small-4-119b-2603',
  'meta/llama-3.2-11b-vision-instruct',
  'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
  'nvidia/gliner-pii',
  'meta/llama-guard-4-12b',
  'nvidia/ising-calibration-1-35b-a3b',
  'upstage/solar-10.7b-instruct',
  'nvidia/nemotron-3-nano-30b-a3b',
  'google/gemma-2-2b-it',
  'mistralai/mixtral-8x7b-instruct-v0.1',
  'nvidia/nemotron-3.5-content-safety',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-nano-8b-v1',
  'meta/llama-3.1-70b-instruct',
  'abacusai/dracarys-llama-3.1-70b-instruct',
  'google/gemma-3n-e4b-it',
  'nvidia/nemotron-nano-12b-v2-vl',
  'meta/llama-3.2-90b-vision-instruct',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'google/gemma-3n-e2b-it',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'deepseek-ai/deepseek-v4-flash',
  'meta/llama-3.2-3b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-1b-instruct',
  'mistralai/mistral-medium-3.5-128b',
];

const DEFAULT_MODEL = 'mistralai/mistral-small-4-119b-2603';

function isAllowedModel(modelId) {
  return ALLOWED_MODELS.includes(modelId);
}

// Reusable helper: send a single-turn (system + user) chat request to NVIDIA
// and return the assistant's reply text. Used by the webhook auto-reply flow
// as well as anything else that needs a one-off AI response.
async function generateReply({ model, systemPrompt, userText, temperature = 0.7, max_tokens = 512 }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not configured');

  const chosenModel = isAllowedModel(model) ? model : DEFAULT_MODEL;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userText });

  const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: chosenModel,
      messages,
      temperature,
      max_tokens,
      top_p: 1,
      stream: false,
    }),
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

  res.json({ models: ALLOWED_MODELS, by_provider: byProvider });
});

// POST /api/ai/chat - Send chat message
router.post('/chat', async (req, res) => {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'NVIDIA_API_KEY not configured' });
  }

  const {
    messages,
    model = 'meta/llama-3.1-70b-instruct',
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
      error: `Model "${model}" not allowed. Available: ${ALLOWED_MODELS.join(', ')}`,
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
