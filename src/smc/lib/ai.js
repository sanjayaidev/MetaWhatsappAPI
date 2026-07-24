const axios = require('axios');

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// Only 5 MistralAI models - mistral-small-4-119b as default
const ALLOWED_MODELS = [
  'mistralai/mistral-small-4-119b-2603', // Default - excellent multilingual support
  'mistralai/mistral-large-3-675b-instruct-2512',
  'mistralai/mistral-medium-3.5-128b',
  'mistralai/ministral-14b-instruct-2512',
  'mistralai/mixtral-8x7b-instruct-v0.1',
];

const DEFAULT_MODEL = 'mistralai/mistral-small-4-119b-2603';

// Rate limits per model (requests per minute)
const MODEL_RPM_OVERRIDES = {
  'mistralai/mistral-small-4-119b-2603': 20,
  'mistralai/mistral-large-3-675b-instruct-2512': 20,
  'mistralai/mistral-medium-3.5-128b': 20,
  'mistralai/ministral-14b-instruct-2512': 20,
  'mistralai/mixtral-8x7b-instruct-v0.1': 20,
};

/**
 * Check if a model is in the allowed list
 */
function isAllowedModel(modelId) {
  return ALLOWED_MODELS.includes(modelId);
}

/**
 * Get rate limit for a specific model
 */
function rpmForModel(modelId) {
  return MODEL_RPM_OVERRIDES[modelId] || 40;
}

/**
 * Generate AI reply using NVIDIA API with MistralAI models
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Configuration options
 * @param {string} options.model - Model to use (default: mistral-small-4-119b)
 * @param {number} options.temperature - Temperature for generation (default: 0.7)
 * @param {number} options.max_tokens - Max tokens in response (default: 2048)
 * @param {boolean} options.stream - Whether to stream the response (default: false)
 * @returns {Promise<Object>} - Response object with content or stream
 */
async function generateReply(messages, options = {}) {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.7,
    max_tokens = 2048,
    stream = false,
  } = options;

  // Validate messages first (before API key check)
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array is required and must not be empty');
  }

  // Validate model (before API key check)
  if (!isAllowedModel(model)) {
    throw new Error(`Model "${model}" is not allowed. Allowed models: ${ALLOWED_MODELS.join(', ')}`);
  }

  // Check API key after input validation
  if (!NVIDIA_API_KEY) {
    throw new Error('NVIDIA_API_KEY environment variable is not set');
  }

  // Format messages for NVIDIA API
  const formattedMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const payload = {
    model,
    messages: formattedMessages,
    temperature,
    max_tokens,
    top_p: 1,
    stream,
  };

  try {
    const response = await axios.post(
      `${NVIDIA_BASE_URL}/chat/completions`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
        },
        responseType: stream ? 'stream' : 'json',
      }
    );

    if (stream) {
      return { stream: true, data: response.data };
    }

    // Extract the assistant's reply from the response
    const content = response.data?.choices?.[0]?.message?.content;
    return {
      success: true,
      content: content || '',
      model: response.data?.model || model,
      usage: response.data?.usage || null,
    };
  } catch (err) {
    console.error('NVIDIA API error:', err.response?.data || err.message);
    throw new Error(`AI reply generation failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

/**
 * Get list of available models
 */
function getAvailableModels() {
  return {
    models: ALLOWED_MODELS,
    default_model: DEFAULT_MODEL,
    total: ALLOWED_MODELS.length,
  };
}

module.exports = {
  generateReply,
  getAvailableModels,
  isAllowedModel,
  rpmForModel,
  DEFAULT_MODEL,
  ALLOWED_MODELS,
};
