// src/ai-core.js — single place for NVIDIA AI config + chat calls.
//
// Required env:   NVIDIA_API_KEY
// Optional env:   AI_MODELS      comma list, first = default, rest = fallback order
//                                (lets you swap a retired model without a code change)
//                 AI_TIMEOUT_MS  per-model timeout, default 8000

const fetch = require('node-fetch');

const DEFAULT_NVIDIA_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'meta/llama-3.2-11b-vision-instruct',
];

const AI_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 8000;

const ALLOWED_MODELS = (process.env.AI_MODELS
  ? process.env.AI_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_NVIDIA_MODELS);
const DEFAULT_MODEL = ALLOWED_MODELS[0];

const getApiKey = () => process.env.NVIDIA_API_KEY || '';
const isAllowedModel = (id) => ALLOWED_MODELS.includes(id);

// Reasoning models can leak <think>…</think> into the reply — never send that to a customer.
function clean(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

async function callOnce({ model, messages, temperature, max_tokens, response_format, signal }) {
  const payload = { model, messages, temperature, max_tokens, top_p: 1, stream: false };
  if (response_format) payload.response_format = response_format;
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiKey()}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.detail || data?.title || `NVIDIA API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const choice = data?.choices?.[0] || {};
  const text = clean(choice.message?.content);
  if (!text) throw new Error('empty reply from model');
  return { text, model: data.model || model, usage: data.usage || null, finish_reason: choice.finish_reason };
}

/**
 * Chat completion with per-attempt timeout and automatic fallback to the next model.
 * Auth errors (401/403) stop immediately — retrying other models won't help.
 * Returns { text, model, usage }.
 */
async function chat({ model, messages, temperature = 0.7, max_tokens = 1024, response_format = null }) {
  if (!getApiKey()) throw new Error('NVIDIA_API_KEY environment variable is not set');
  const first = isAllowedModel(model) ? model : DEFAULT_MODEL;
  const order = [first, ...ALLOWED_MODELS.filter((m) => m !== first)];

  const failures = [];
  for (const m of order) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const out = await callOnce({ model: m, messages, temperature, max_tokens, response_format, signal: ctrl.signal });
      if (failures.length) console.warn(`[ai] used fallback ${m} after: ${failures.join(' | ')}`);
      return out;
    } catch (err) {
      const why = err.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : err.message;
      failures.push(`${m}: ${why}`);
      if (err.status === 401 || err.status === 403) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`All AI models failed — ${failures.join(' | ')}`);
}

module.exports = { chat, clean, getApiKey, isAllowedModel, ALLOWED_MODELS, DEFAULT_MODEL, AI_BASE_URL, TIMEOUT_MS };
