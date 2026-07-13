// src/whatsapp-interactive.js
//
// Builds and validates WhatsApp Cloud API free-form interactive message
// payloads (text, button, list, cta_url) — the kind sendable within an
// active 24h session window, no template approval needed.
//
// This mirrors Meta's actual limits so bad input fails fast, locally,
// with a clear error — instead of a vague 400 from graph.facebook.com.

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

class WhatsAppValidationError extends Error {}

/** Replaces {{variable}} placeholders using values from `vars`. Leaves unmatched ones as-is. */
function renderTemplate(input, vars = {}) {
  if (typeof input !== 'string') return input;
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function validateRecipient(to) {
  if (!/^\d{10,15}$/.test(to)) {
    throw new WhatsAppValidationError(
      `Recipient "${to}" should be digits only, no '+' or spaces (e.g. "91XXXXXXXXXX").`
    );
  }
}

function validateButtonConfig(cfg) {
  const buttons = cfg.buttons || [];
  if (buttons.length === 0) throw new WhatsAppValidationError('Button message needs at least 1 button.');
  if (buttons.length > 3) throw new WhatsAppValidationError(`Button message supports max 3 buttons, got ${buttons.length}.`);
  const seenIds = new Set();
  for (const btn of buttons) {
    if (!btn.id || !btn.title) throw new WhatsAppValidationError('Each button needs an id and a title.');
    if (btn.title.length > 20) throw new WhatsAppValidationError(`Button title "${btn.title}" exceeds 20 characters.`);
    if (EMOJI_REGEX.test(btn.title)) throw new WhatsAppValidationError(`Button title "${btn.title}" contains an emoji (not supported).`);
    if (seenIds.has(btn.id)) throw new WhatsAppValidationError(`Duplicate button id "${btn.id}".`);
    seenIds.add(btn.id);
  }
}

function validateListConfig(cfg) {
  const sections = cfg.sections || [];
  const totalRows = sections.reduce((sum, s) => sum + (s.rows || []).length, 0);
  if (totalRows === 0) throw new WhatsAppValidationError('List message needs at least 1 row.');
  if (totalRows > 10) throw new WhatsAppValidationError(`List message supports max 10 rows total, got ${totalRows}.`);
  if (!cfg.buttonLabel || cfg.buttonLabel.length > 20) throw new WhatsAppValidationError('List buttonLabel is required and must be <= 20 characters.');
  for (const section of sections) {
    if (!section.title || section.title.length > 24) throw new WhatsAppValidationError(`Section title "${section.title}" is required and must be <= 24 characters.`);
    for (const row of section.rows || []) {
      if (!row.id || !row.title) throw new WhatsAppValidationError('Each row needs an id and a title.');
      if (row.title.length > 24) throw new WhatsAppValidationError(`Row title "${row.title}" exceeds 24 characters.`);
      if (row.description && row.description.length > 72) throw new WhatsAppValidationError(`Row description for "${row.title}" exceeds 72 characters.`);
    }
  }
}

function validateCtaUrlConfig(cfg) {
  if (!cfg.displayText || cfg.displayText.length > 20) throw new WhatsAppValidationError('cta_url displayText is required and must be <= 20 characters.');
  if (!cfg.url || !cfg.url.trim()) throw new WhatsAppValidationError('cta_url url is required.');
}

// 'raw' is a manually-authored/pasted `interactive` object, saved as-is
// (wrapped as { interactive: {...} }) rather than built field-by-field.
// Used by the "Save as Template" action on the Manual JSON tab. We only
// check the minimum shape here — Meta's API is still the final judge of
// deeper correctness, same as it would be for a one-off manual send.
function validateRawConfig(cfg) {
  if (!cfg.interactive || typeof cfg.interactive !== 'object') {
    throw new WhatsAppValidationError('raw template config must be { interactive: {...} }.');
  }
  if (!cfg.interactive.type) {
    throw new WhatsAppValidationError('raw template interactive object must have a "type" field.');
  }
}

/** Validates a template config object against Meta's limits for its `kind`. Throws WhatsAppValidationError. */
function validateTemplateConfig(kind, cfg) {
  if (kind === 'text') {
    if (!cfg.body || !cfg.body.trim()) throw new WhatsAppValidationError('Text message body is required.');
    return;
  }
  if (kind === 'button') return validateButtonConfig(cfg);
  if (kind === 'list') return validateListConfig(cfg);
  if (kind === 'cta_url') return validateCtaUrlConfig(cfg);
  if (kind === 'raw') return validateRawConfig(cfg);
  throw new WhatsAppValidationError(`Unknown template kind "${kind}".`);
}

function buildButtonInteractive(cfg, vars) {
  const interactive = {
    type: 'button',
    body: { text: renderTemplate(cfg.body, vars) },
    action: {
      buttons: cfg.buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: renderTemplate(b.title, vars) },
      })),
    },
  };
  if (cfg.header) interactive.header = { type: 'text', text: renderTemplate(cfg.header, vars) };
  if (cfg.footer) interactive.footer = { text: renderTemplate(cfg.footer, vars) };
  return interactive;
}

function buildListInteractive(cfg, vars) {
  const interactive = {
    type: 'list',
    body: { text: renderTemplate(cfg.body, vars) },
    action: {
      button: renderTemplate(cfg.buttonLabel, vars),
      sections: cfg.sections.map((s) => ({
        title: renderTemplate(s.title, vars),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: renderTemplate(r.title, vars),
          ...(r.description ? { description: renderTemplate(r.description, vars) } : {}),
        })),
      })),
    },
  };
  if (cfg.header) interactive.header = { type: 'text', text: renderTemplate(cfg.header, vars) };
  if (cfg.footer) interactive.footer = { text: renderTemplate(cfg.footer, vars) };
  return interactive;
}

function buildCtaInteractive(cfg, vars) {
  const interactive = {
    type: 'cta_url',
    body: { text: renderTemplate(cfg.body, vars) },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: renderTemplate(cfg.displayText, vars),
        url: renderTemplate(cfg.url, vars),
      },
    },
  };
  if (cfg.header) interactive.header = { type: 'text', text: renderTemplate(cfg.header, vars) };
  if (cfg.footer) interactive.footer = { text: renderTemplate(cfg.footer, vars) };
  return interactive;
}

/**
 * Builds a ready-to-POST WhatsApp Cloud API payload from a template kind +
 * config + recipient + variables. Validates against Meta's limits first —
 * throws WhatsAppValidationError with a clear message if something's off.
 */
function buildMessagePayload(kind, cfg, to, vars = {}) {
  validateRecipient(to);
  validateTemplateConfig(kind, cfg);

  if (kind === 'text') {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: renderTemplate(cfg.body, vars) },
    };
  }

  let interactive;
  if (kind === 'button') interactive = buildButtonInteractive(cfg, vars);
  else if (kind === 'list') interactive = buildListInteractive(cfg, vars);
  else if (kind === 'cta_url') interactive = buildCtaInteractive(cfg, vars);
  else if (kind === 'raw') {
    // Render {{variables}} across the whole JSON blob (stringify -> replace -> parse)
    // so raw/saved templates support the same personalization as built ones.
    interactive = JSON.parse(renderTemplate(JSON.stringify(cfg.interactive), vars));
  }

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive,
  };
}

module.exports = {
  WhatsAppValidationError,
  renderTemplate,
  validateRecipient,
  validateTemplateConfig,
  buildMessagePayload,
};
