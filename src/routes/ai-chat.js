// AI Chat endpoint using NVIDIA's OpenAI-compatible API
// No aider needed - just direct API calls

const express = require('express');
const router = express.Router();

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// Allowed models from NVIDIA
const ALLOWED_MODELS = [
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-90b-vision-instruct',
  'meta/llama-3.3-70b-instruct',
  'mistralai/mistral-large-3-675b-instruct-2512',
  'mistralai/mistral-small-4-119b-2603',
  'mistralai/mixtral-8x7b-instruct-v0.1',
  'moonshotai/kimi-k2.6',
  'deepseek-ai/deepseek-v4-flash',
  'deepseek-ai/deepseek-v4-pro',
  'abacusai/dracarys-llama-3.1-70b-instruct',
];

function isAllowedModel(modelId) {
  return ALLOWED_MODELS.includes(modelId);
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
