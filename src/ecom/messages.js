// src/ecom/messages.js — builds the actual WhatsApp Graph API message
// payloads for the ecom bot flow (catalog browsing, cart summary, checkout
// link). Kept separate from src/whatsapp-interactive.js's bot-builder
// template renderer because these are generated dynamically from live
// wb_products/cart data, not from a saved static template payload.
//
// Row/button ids follow an "ecom_<action>[:<id>]" convention so server.js's
// inbound handler can recognize an ecom interactive reply before it even
// reaches the keyword-based bot-engine rules (see server.js's ecom branch).
const MAX_LIST_ROWS = 10; // WhatsApp interactive list hard limit per section

function money(amount, currency) {
  return `${currency === 'INR' ? '₹' : currency + ' '}${Number(amount).toFixed(2)}`;
}

// One interactive list message, one row per product (capped at 10 — WhatsApp's
// limit). If a merchant has more than 10 active products, only show the
// first 10; a "browse more" experience is a fair next iteration but out of
// scope for the bot's basic catalog message.
function buildCatalogMessage(to, products, greeting) {
  const rows = products.slice(0, MAX_LIST_ROWS).map((p) => ({
    id: `ecom_add:${p.id}`,
    title: p.name.slice(0, 24), // WhatsApp row title limit
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

// Text summary + reply buttons for "Checkout" / "Clear cart". WhatsApp
// reply-button messages cap at 3 buttons, so this stays deliberately simple.
function buildCartSummaryMessage(to, cartSummary, checkoutLabel, currency) {
  if (!cartSummary.items.length) {
    return { messaging_product: 'whatsapp', to, type: 'text', text: { body: 'Your cart is empty. Say "shop" to browse products!' } };
  }
  const lines = cartSummary.items.map((i) => `• ${i.name} x${i.quantity} — ${money(i.unit_price * i.quantity, currency)}`);
  const total = money(cartSummary.total, currency);
  const body = `🛒 Your cart:\n\n${lines.join('\n')}\n\nTotal: ${total}`;
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

// A single confirmation line after "Add to cart" is tapped, plus a quick way
// to jump straight to viewing the cart without retyping anything.
function buildAddedToCartMessage(to, productName, cartSummary, currency) {
  const total = money(cartSummary.total, currency);
  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `Added *${productName}* to your cart.\nCart total: ${total}` },
      action: { buttons: [{ type: 'reply', reply: { id: 'ecom_view_cart', title: 'View Cart' } }] },
    },
  };
}

// A cta_url message pointing at the checkout page. Stripe/PayPal give a real
// redirect URL directly from src/payments.js. Razorpay doesn't (Checkout.js
// is a client-side widget, not a hosted page) so for Razorpay orders this
// points at this repo's own /ecom-pay.html?order_id=... page instead, which
// mounts Checkout.js using the order's client_fields.
function buildCheckoutLinkMessage(to, checkoutUrl) {
  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: 'Tap below to complete your payment securely.' },
      action: { name: 'cta_url', parameters: { display_text: 'Pay Now', url: checkoutUrl } },
    },
  };
}

module.exports = { buildCatalogMessage, buildCartSummaryMessage, buildAddedToCartMessage, buildCheckoutLinkMessage };
