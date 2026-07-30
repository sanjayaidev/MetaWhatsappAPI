// src/ecom/messages.js — builds the actual Meta Graph API message payloads
// for the ecom bot flow (catalog browsing, cart summary, checkout link),
// across all three supported channels: WhatsApp, Instagram, Facebook.
//
// WHY ONE FILE FOR ALL THREE CHANNELS:
// Instagram DMs and Facebook Page Messenger both send through the exact same
// Graph API call — POST /me/messages with a { recipient, message } body (see
// src/channel-send.js's sendFacebookMessage/sendInstagramMessage) — so their
// payload shapes are identical to each other and only differ from WhatsApp's
// `{ messaging_product: 'whatsapp', to, type, ... }` shape. Rather than a
// separate messages-ig.js/messages-fb.js that would just duplicate the same
// Messenger builders twice, every build* function here takes a `channel`
// argument and returns the right shape for whichever one is passed.
//
// CHANNEL CAPABILITY DIFFERENCES THAT SHAPE THIS FILE:
//   - WhatsApp: rich native "interactive" types — list (up to 10 rows,
//     grouped in sections), reply buttons (max 3), cta_url (one link button).
//   - Instagram / Facebook (Messenger platform): no native "list" type at
//     all. The closest equivalent is a "generic" template — a horizontally
//     scrollable carousel of up to 10 cards (image/title/subtitle/buttons),
//     which is what we use for the catalog. Buttons come in two flavors:
//     `postback` (fires a postback event back to our webhook, used for
//     "Add to cart") and `web_url` (opens a link, used for "Pay Now").
//     Free-form multi-choice text prompts use `quick_replies` instead of
//     reply buttons — those disappear after one tap, which fits "View Cart" /
//     "Clear cart" / "Checkout" perfectly (same one-shot semantics as
//     WhatsApp reply buttons).
//
// Row/button/postback ids all keep the existing "ecom_<action>[:<id>]"
// convention across every channel, so server.js's inbound handler
// (handleEcomInteraction) can recognize an ecom reply the same way
// regardless of which channel it came in on — see server.js webhook
// handling for WhatsApp interactive replies, Messenger postbacks, and
// Messenger quick_reply payloads.

const MAX_LIST_ROWS = 10;       // WhatsApp interactive list hard limit per section
const MAX_CAROUSEL_CARDS = 10;  // Messenger generic template hard limit per message

const CHANNELS = ['whatsapp', 'instagram', 'facebook'];

function assertChannel(channel) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unsupported ecom channel "${channel}" — must be one of: ${CHANNELS.join(', ')}`);
  }
}

function money(amount, currency) {
  return `${currency === 'INR' ? '₹' : currency + ' '}${Number(amount).toFixed(2)}`;
}

// Messenger (Instagram + Facebook share this exact shape) message envelope.
function messengerEnvelope(to, message) {
  return { recipient: { id: to }, message };
}

// ─────────────────────────────────────────────────────────────────────────
// Catalog message — product list/carousel, tap a product to add it to cart.
// ─────────────────────────────────────────────────────────────────────────
function buildCatalogMessage(channel, to, products, greeting) {
  assertChannel(channel);
  const shown = products.slice(0, channel === 'whatsapp' ? MAX_LIST_ROWS : MAX_CAROUSEL_CARDS);

  if (channel === 'whatsapp') {
    const rows = shown.map((p) => ({
      id: `ecom_add:${p.id}`,
      title: p.name.slice(0, 24),                       // WhatsApp row title limit
      description: money(p.price, p.currency).slice(0, 72),
    }));
    return {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: greeting || "Here's what we have available:" },
        action: { button: 'Browse Products', sections: [{ title: 'Products', rows }] },
      },
    };
  }

  // Instagram / Facebook: generic template carousel, one card per product.
  // A caption/greeting isn't part of the template attachment itself on
  // Messenger, so it's sent as its own preceding text message — server.js
  // sends both (see the ecom_catalog trigger) rather than dropping it.
  const elements = shown.map((p) => ({
    title: p.name.slice(0, 80),
    subtitle: money(p.price, p.currency),
    image_url: p.image_url || undefined,
    buttons: [
      { type: 'postback', title: 'Add to Cart', payload: `ecom_add:${p.id}` },
    ],
  }));
  return messengerEnvelope(to, {
    attachment: {
      type: 'template',
      payload: { template_type: 'generic', elements },
    },
  });
}

// A separate plain-text greeting to send right before the catalog carousel
// on Instagram/Facebook (WhatsApp folds the greeting into the list's body
// text already, so this is a no-op there — callers should only invoke it
// for instagram/facebook, but it's safe either way).
function buildCatalogGreetingMessage(channel, to, greeting) {
  assertChannel(channel);
  const text = greeting || "Here's what we have available:";
  if (channel === 'whatsapp') return { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  return messengerEnvelope(to, { text });
}

// ─────────────────────────────────────────────────────────────────────────
// Cart summary — line items + total, with Checkout / Clear cart actions.
// ─────────────────────────────────────────────────────────────────────────
function buildCartSummaryMessage(channel, to, cartSummary, checkoutLabel, currency) {
  assertChannel(channel);

  if (!cartSummary.items.length) {
    const text = 'Your cart is empty. Say "shop" to browse products!';
    return channel === 'whatsapp'
      ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
      : messengerEnvelope(to, { text });
  }

  const lines = cartSummary.items.map((i) => `• ${i.name} x${i.quantity} — ${money(i.unit_price * i.quantity, currency)}`);
  const total = money(cartSummary.total, currency);
  const body = `🛒 Your cart:\n\n${lines.join('\n')}\n\nTotal: ${total}`;

  if (channel === 'whatsapp') {
    return {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'ecom_checkout', title: (checkoutLabel || 'Checkout').slice(0, 20) } },
            { type: 'reply', reply: { id: 'ecom_clear', title: 'Clear cart' } },
          ],
        },
      },
    };
  }

  // Instagram / Facebook: quick_replies are the Messenger equivalent of
  // WhatsApp reply buttons — one-shot, disappear after tap, up to 13 allowed
  // (we only ever need 2 here so the WhatsApp 3-button cap isn't a concern).
  return messengerEnvelope(to, {
    text: body,
    quick_replies: [
      { content_type: 'text', title: (checkoutLabel || 'Checkout').slice(0, 20), payload: 'ecom_checkout' },
      { content_type: 'text', title: 'Clear cart', payload: 'ecom_clear' },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// "Added to cart" confirmation, with a shortcut straight to viewing the cart.
// ─────────────────────────────────────────────────────────────────────────
function buildAddedToCartMessage(channel, to, productName, cartSummary, currency) {
  assertChannel(channel);
  const total = money(cartSummary.total, currency);
  const body = `Added *${productName}* to your cart.\nCart total: ${total}`;

  if (channel === 'whatsapp') {
    return {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: [{ type: 'reply', reply: { id: 'ecom_view_cart', title: 'View Cart' } }] },
      },
    };
  }

  return messengerEnvelope(to, {
    // Messenger has no bold markdown — send the plain-text equivalent.
    text: `Added ${productName} to your cart.\nCart total: ${total}`,
    quick_replies: [{ content_type: 'text', title: 'View Cart', payload: 'ecom_view_cart' }],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Checkout link — a single link button pointing at the hosted payment page.
// ─────────────────────────────────────────────────────────────────────────
function buildCheckoutLinkMessage(channel, to, checkoutUrl) {
  assertChannel(channel);

  if (channel === 'whatsapp') {
    return {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: 'Tap below to complete your payment securely.' },
        action: { name: 'cta_url', parameters: { display_text: 'Pay Now', url: checkoutUrl } },
      },
    };
  }

  // Messenger "button" template: text + up to 3 buttons, web_url type opens
  // the link in the in-app browser — the direct FB/IG equivalent of cta_url.
  return messengerEnvelope(to, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: 'Tap below to complete your payment securely.',
        buttons: [{ type: 'web_url', title: 'Pay Now', url: checkoutUrl }],
      },
    },
  });
}

module.exports = {
  CHANNELS,
  buildCatalogMessage,
  buildCatalogGreetingMessage,
  buildCartSummaryMessage,
  buildAddedToCartMessage,
  buildCheckoutLinkMessage,
};
