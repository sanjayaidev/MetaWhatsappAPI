// src/interactive-templates.js — Supabase-backed CRUD for reusable
// interactive message templates, plus an AI "customize this template" helper.
// Follows the same pattern as src/api-keys.js: its own supabase client,
// plain async functions, called from routes defined in server.js.

const { createClient } = require('@supabase/supabase-js');
const { validateTemplateConfig, WhatsAppValidationError } = require('./whatsapp-interactive');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function listTemplates(userId) {
  const { data, error } = await supabase
    .from('wb_interactive_templates')
    .select('id, name, kind, config, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function createTemplate(userId, { name, kind, config }) {
  if (!name || !name.trim()) throw new WhatsAppValidationError('Template name is required.');
  validateTemplateConfig(kind, config); // fail fast before it ever hits the DB

  const { data, error } = await supabase
    .from('wb_interactive_templates')
    .insert({ user_id: userId, name: name.trim(), kind, config })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteTemplate(userId, templateId) {
  const { error } = await supabase
    .from('wb_interactive_templates')
    .delete()
    .eq('id', templateId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

async function getTemplate(userId, templateId) {
  const { data, error } = await supabase
    .from('wb_interactive_templates')
    .select('id, name, kind, config')
    .eq('id', templateId)
    .eq('user_id', userId)
    .single();
  if (error || !data) throw new Error('Template not found.');
  return data;
}

/**
 * Asks the AI to rewrite a template's copy per a free-text instruction,
 * while KEEPING the JSON shape intact (button ids, structure). We never
 * trust the AI's JSON blindly — it's parsed and re-validated with the same
 * validateTemplateConfig() used for manually-authored templates, so a
 * malformed or over-limit AI response gets rejected before it can reach
 * Meta's API, same as any other bad input would.
 *
 * `generateReply` is the existing NVIDIA chat helper from ai-chat.js —
 * reused here rather than adding a second AI integration.
 */
async function customizeTemplateWithAI({ generateReply, kind, config, instruction, model }) {
  const systemPrompt = [
    'You customize WhatsApp message JSON for a business.',
    'You will be given a JSON object and an instruction.',
    'Rewrite ONLY the human-readable text fields (body, header, footer, button/row titles, descriptions, displayText) per the instruction.',
    'Do NOT add, remove, or reorder buttons/rows/sections. Do NOT change any "id" field. Do NOT change the JSON structure or keys.',
    'Respect these limits strictly: button/row titles <= 20 chars for buttons, <= 24 chars for list rows, list row descriptions <= 72 chars, no emoji in button titles.',
    'Reply with ONLY the raw JSON object. No markdown fences, no explanation, no extra text before or after.',
  ].join(' ');

  const userText = `Instruction: ${instruction}\n\nCurrent JSON:\n${JSON.stringify(config)}`;

  const raw = await generateReply({
    model,
    systemPrompt,
    userText,
    temperature: 0.5,
    max_tokens: 800,
  });

  let parsed;
  try {
    // Strip accidental markdown fences in case the model ignores the instruction not to add them
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new WhatsAppValidationError('AI did not return valid JSON. Try rephrasing the instruction, or edit manually.');
  }

  // Re-validate before ever returning it to the client as "ready to send"
  validateTemplateConfig(kind, parsed);

  return parsed;
}

module.exports = {
  listTemplates,
  createTemplate,
  deleteTemplate,
  getTemplate,
  customizeTemplateWithAI,
};
