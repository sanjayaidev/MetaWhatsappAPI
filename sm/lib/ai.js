// sm/lib/ai.js — Social Manager AI helper.
// Now shares provider/model config with the main app (src/ai-core.js):
// timeout and automatic model fallback.
const axios = require('axios');
const core = require('../../src/ai-core');

const { ALLOWED_MODELS, DEFAULT_MODEL, isAllowedModel, AI_BASE_URL } = core;

function rpmForModel(_modelId) {
  return 40;
}

/**
 * Generate an AI reply.
 *  - generateReply("prompt string")           -> returns the reply TEXT (string)
 *    (this is how sm/routes/webhooks.js and sm/automations/matcher.js call it)
 *  - generateReply([{role, content}], opts)    -> returns { success, content, model, usage }
 *    (this is how sm/routes/ai.js calls it; opts.stream returns { stream: true, data })
 */
async function generateReply(input, options = {}) {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.7,
    max_tokens = 1024,
    stream = false,
  } = options;

  const wantsText = typeof input === 'string';
  const messages = wantsText ? [{ role: 'user', content: input }] : input;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array is required and must not be empty');
  }
  const formatted = messages.map((m) => ({ role: m.role, content: m.content }));

  if (stream) {
    if (!core.getApiKey()) throw new Error('NVIDIA_API_KEY environment variable is not set');
    const useModel = isAllowedModel(model) ? model : DEFAULT_MODEL;
    const response = await axios.post(
      `${AI_BASE_URL}/chat/completions`,
      { model: useModel, messages: formatted, temperature, max_tokens, top_p: 1, stream: true },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${core.getApiKey()}` },
        responseType: 'stream',
      }
    );
    return { stream: true, data: response.data };
  }

  try {
    const out = await core.chat({ model, messages: formatted, temperature, max_tokens });
    if (wantsText) return out.text;
    return { success: true, content: out.text, model: out.model, usage: out.usage };
  } catch (err) {
    console.error('[sm/ai] generation failed:', err.message);
    if (wantsText) return ''; // callers treat '' as "AI unavailable" and fall back to variations
    throw new Error(`AI reply generation failed: ${err.message}`);
  }
}

function getAvailableModels() {
  return { success: true, models: ALLOWED_MODELS, default_model: DEFAULT_MODEL, total: ALLOWED_MODELS.length };
}

module.exports = {
  generateReply,
  getAvailableModels,
  isAllowedModel,
  rpmForModel,
  DEFAULT_MODEL,
  ALLOWED_MODELS,
};
