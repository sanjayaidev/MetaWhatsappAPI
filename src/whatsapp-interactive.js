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

// Validates an already Meta-shaped `interactive` object directly (the actual
// wire format, e.g. { type: "button", action: { buttons: [{ type: "reply",
// reply: { id, title } }] } } — as opposed to the flatter builder `cfg` shapes
// validateButtonConfig/validateListConfig/validateCtaUrlConfig above expect).
// Used to check AI-generated or hand-pasted interactive JSON before it's
// treated as "ready to send". Throws WhatsAppValidationError.
function validateInteractiveObject(obj) {
  if (!obj || typeof obj !== 'object') throw new WhatsAppValidationError('Interactive message must be a JSON object.');
  if (!obj.body || !obj.body.text || !obj.body.text.trim()) throw new WhatsAppValidationError('Interactive message needs a body.text.');

  if (obj.type === 'button') {
    const buttons = obj.action?.buttons || [];
    if (buttons.length === 0) throw new WhatsAppValidationError('Button message needs at least 1 button.');
    if (buttons.length > 3) throw new WhatsAppValidationError(`Button message supports max 3 buttons, got ${buttons.length}.`);
    const seenIds = new Set();
    for (const btn of buttons) {
      const id = btn.reply?.id, title = btn.reply?.title;
      if (!id || !title) throw new WhatsAppValidationError('Each button needs action.buttons[].reply.id and .title.');
      if (title.length > 20) throw new WhatsAppValidationError(`Button title "${title}" exceeds 20 characters.`);
      if (EMOJI_REGEX.test(title)) throw new WhatsAppValidationError(`Button title "${title}" contains an emoji (not supported).`);
      if (seenIds.has(id)) throw new WhatsAppValidationError(`Duplicate button id "${id}".`);
      seenIds.add(id);
    }
  } else if (obj.type === 'list') {
    const sections = obj.action?.sections || [];
    const totalRows = sections.reduce((sum, s) => sum + (s.rows || []).length, 0);
    if (totalRows === 0) throw new WhatsAppValidationError('List message needs at least 1 row.');
    if (totalRows > 10) throw new WhatsAppValidationError(`List message supports max 10 rows total, got ${totalRows}.`);
    if (!obj.action?.button || obj.action.button.length > 20) throw new WhatsAppValidationError('List action.button label is required and must be <= 20 characters.');
    for (const section of sections) {
      if (!section.title || section.title.length > 24) throw new WhatsAppValidationError(`Section title "${section.title}" is required and must be <= 24 characters.`);
      for (const row of section.rows || []) {
        if (!row.id || !row.title) throw new WhatsAppValidationError('Each row needs an id and a title.');
        if (row.title.length > 24) throw new WhatsAppValidationError(`Row title "${row.title}" exceeds 24 characters.`);
        if (row.description && row.description.length > 72) throw new WhatsAppValidationError(`Row description for "${row.title}" exceeds 72 characters.`);
      }
    }
  } else if (obj.type === 'cta_url') {
    const params = obj.action?.parameters || {};
    if (!params.display_text || params.display_text.length > 20) throw new WhatsAppValidationError('cta_url action.parameters.display_text is required and must be <= 20 characters.');
    if (!params.url || !params.url.trim()) throw new WhatsAppValidationError('cta_url action.parameters.url is required.');
  } else {
    throw new WhatsAppValidationError(`Unsupported interactive type "${obj.type}". Must be "button", "list", or "cta_url".`);
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

// ------------------------------------------------------------------------
// Bot-builder templates (wb_bot_templates.payload, saved by chatbot-builder.
// html's computeTemplateJSON()) are stored in a flat, home-grown shape —
// NOT the actual WhatsApp Graph API `interactive` object shape:
//
//   { template_id, type: 'interactive', interactive_type, header: {type, text|url},
//     body: '...', footer: '...', action: {...} }
//
// e.g. a button's action is `{ buttons: [{ id, title }] }`, not Graph's
// `{ buttons: [{ type: 'reply', reply: { id, title } }] }`; a list's rows
// live flat under `action.options`, not nested under `action.sections[].rows`;
// and there's no `messaging_product`/`to`/`interactive` wrapper at all.
//
// bot-engine.js used to spread this payload directly into the send body
// (`{ messaging_product, to, ...tpl.payload }`), which Meta rejects with
// "(#100) Invalid parameter" since the shape doesn't match the Graph API's
// interactive-message spec. This function does the actual conversion.
//
// `rowType` is wb_bot_templates.type ('plaintext' | 'buttons' | 'list' | 'cta' | 'product') —
// more reliable than payload.type, which computeTemplateJSON always sets to
// 'interactive' regardless of the template's real kind (a UI-side quirk,
// not something to rely on here).
function toGraphHeader(header) {
  if (!header || header.type === 'none') return null;
  if (header.type === 'image') return header.url ? { type: 'image', image: { link: header.url } } : null;
  return header.text ? { type: 'text', text: header.text } : null;
}

function toGraphFooter(footerText) {
  return footerText && footerText.trim() ? { text: footerText } : null;
}

function buildBotBuilderTemplatePayload(rowType, payload, to) {
  validateRecipient(to);
  payload = payload || {};

  if (rowType === 'plaintext') {
    if (!payload.body || !payload.body.trim()) throw new WhatsAppValidationError('Plaintext bot template has no body text.');
    return { messaging_product: 'whatsapp', to, type: 'text', text: { body: payload.body } };
  }

  if (rowType === 'buttons') {
    const interactive = {
      type: 'button',
      body: { text: payload.body || '' },
      action: {
        buttons: (payload.action?.buttons || []).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    };
    const header = toGraphHeader(payload.header);
    const footer = toGraphFooter(payload.footer);
    if (header) interactive.header = header;
    if (footer) interactive.footer = footer;
    validateInteractiveObject(interactive);
    return { messaging_product: 'whatsapp', to, type: 'interactive', interactive };
  }

  if (rowType === 'list') {
    const interactive = {
      type: 'list',
      body: { text: payload.body || '' },
      action: {
        button: payload.action?.button || 'Options',
        sections: [{
          title: (payload.action?.button || 'Options').slice(0, 24),
          rows: (payload.action?.options || []).map((o) => ({
            id: o.id,
            title: o.title,
            ...(o.description ? { description: o.description } : {}),
          })),
        }],
      },
    };
    const header = toGraphHeader(payload.header);
    const footer = toGraphFooter(payload.footer);
    if (header) interactive.header = header;
    if (footer) interactive.footer = footer;
    validateInteractiveObject(interactive);
    return { messaging_product: 'whatsapp', to, type: 'interactive', interactive };
  }

  if (rowType === 'cta') {
    // The builder also allows a "Call number" CTA (kind: 'phone'), but WhatsApp's
    // cta_url interactive type only supports opening a URL — there's no native
    // "tap to call" interactive button in the Cloud API. Fall back to a plain
    // text message with the number included rather than sending an invalid payload.
    if (payload.action?.kind === 'phone') {
      const number = payload.action?.value || '';
      return {
        messaging_product: 'whatsapp', to, type: 'text',
        text: { body: `${payload.body || ''}${number ? `\n\n📞 ${number}` : ''}`.trim() },
      };
    }
    const interactive = {
      type: 'cta_url',
      body: { text: payload.body || '' },
      action: {
        name: 'cta_url',
        parameters: {
          display_text: payload.action?.button_label || 'Open',
          url: payload.action?.value || '',
        },
      },
    };
    const header = toGraphHeader(payload.header);
    const footer = toGraphFooter(payload.footer);
    if (header) interactive.header = header;
    if (footer) interactive.footer = footer;
    validateInteractiveObject(interactive);
    return { messaging_product: 'whatsapp', to, type: 'interactive', interactive };
  }

  if (rowType === 'product') {
    // A real Graph API product message needs catalog_id + product_retailer_id
    // from a connected Facebook catalog — this builder only stores a title/
    // price/image URL, not catalog data, so a valid product message can't be
    // built from it. Degrade gracefully to an image (or text) message instead
    // of sending something Meta will reject.
    const caption = [payload.product?.title, payload.product?.price].filter(Boolean).join(' — ') + (payload.body ? `\n\n${payload.body}` : '');
    if (payload.header?.url) {
      return { messaging_product: 'whatsapp', to, type: 'image', image: { link: payload.header.url, caption } };
    }
    return { messaging_product: 'whatsapp', to, type: 'text', text: { body: caption || '[Product]' } };
  }

  throw new WhatsAppValidationError(`Unsupported bot template type "${rowType}".`);
}

module.exports = {
  WhatsAppValidationError,
  renderTemplate,
  validateRecipient,
  validateTemplateConfig,
  validateInteractiveObject,
  buildMessagePayload,
  buildBotBuilderTemplatePayload,
};
