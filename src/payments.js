// src/payments.js — provider-agnostic checkout + verification, shared by any
// module that needs to take a payment (ecom checkout, CRM billing, chatbot
// builder "pay now" buttons, etc). Adapted from the donationalert project's
// single-amount "tip" checkout: same three providers (Razorpay, Stripe,
// PayPal) and the same create → pending-row → verify/poll pattern, but
// generalized to take a cart (array of line items) instead of one fixed
// amount, and to write to this repo's wb_orders / wb_order_items tables
// instead of a `donations` table.
//
// Usage:
//   const payments = require('./payments')({ supabase });
//   const { checkout_url, provider_order_id } = await payments.createCheckout({
//     provider: 'razorpay', order, items, successUrl, cancelUrl,
//   });
//   ... later, from a webhook or poll ...
//   const status = await payments.verifyPayment({ provider, order });

const fetch = require('node-fetch');

module.exports = function createPaymentsModule({ supabase }) {
  const isTestMode = process.env.PAYMENTS_TEST_MODE !== 'false'; // default to test/sandbox unless explicitly turned off

  function creds(provider) {
    const upper = provider.toUpperCase();
    const test = (name) => process.env[`${upper}_TEST_${name}`] || process.env[`${upper}_${name}`];
    const live = (name) => process.env[`${upper}_${name}`];
    return isTestMode ? test : live;
  }

  // ─── Razorpay ────────────────────────────────────────────────────────────
  async function createRazorpayOrder({ order, successUrl }) {
    const get = creds('razorpay');
    const keyId = get('KEY_ID');
    const keySecret = get('KEY_SECRET');
    if (!keyId || !keySecret) throw new Error(`Razorpay credentials not set for ${isTestMode ? 'TEST' : 'PRODUCTION'} mode`);

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify({
        amount: Math.round(Number(order.amount) * 100), // paise
        currency: order.currency || 'INR',
        receipt: order.id,
        notes: { order_id: order.id, contact_name: order.contact_name || '' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.description || `Razorpay order creation failed (${res.status})`);
    return {
      provider_order_id: data.id,
      checkout_url: null, // Razorpay uses Checkout.js client-side with key_id + order_id, not a redirect URL
      client_fields: { razorpay_key_id: keyId, razorpay_order_id: data.id },
    };
  }

  async function verifyRazorpayOrder({ order }) {
    const get = creds('razorpay');
    const keyId = get('KEY_ID');
    const keySecret = get('KEY_SECRET');
    const res = await fetch(`https://api.razorpay.com/v1/orders/${order.provider_order_id}/payments`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64') },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.description || 'Razorpay payment lookup failed');
    const captured = (data.items || []).find((p) => p.status === 'captured');
    return captured ? 'paid' : 'pending';
  }

  function verifyRazorpayWebhookSignature(rawBody, signatureHeader) {
    const crypto = require('crypto');
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return expected === signatureHeader;
  }

  // ─── Stripe ──────────────────────────────────────────────────────────────
  async function createStripeSession({ order, items, successUrl, cancelUrl }) {
    const get = creds('stripe');
    const secretKey = get('SECRET_KEY');
    if (!secretKey) throw new Error(`Stripe credentials not set for ${isTestMode ? 'TEST' : 'PRODUCTION'} mode`);
    const currency = (order.currency || 'usd').toLowerCase();

    const body = new URLSearchParams();
    body.append('mode', 'payment');
    body.append('success_url', successUrl);
    body.append('cancel_url', cancelUrl);
    body.append('client_reference_id', order.id);
    if (order.contact_email) body.append('customer_email', order.contact_email);
    body.append('metadata[order_id]', order.id);

    (items && items.length ? items : [{ name: 'Order', unit_price: order.amount, quantity: 1 }]).forEach((item, i) => {
      body.append(`line_items[${i}][quantity]`, String(item.quantity || 1));
      body.append(`line_items[${i}][price_data][currency]`, currency);
      body.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(Number(item.unit_price) * 100)));
      body.append(`line_items[${i}][price_data][product_data][name]`, item.name || 'Item');
    });

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${secretKey}` },
      body: body.toString(),
    });
    const session = await res.json();
    if (!res.ok || !session.url) throw new Error(session.error?.message || `Stripe checkout session creation failed (${res.status})`);
    return { provider_order_id: session.id, checkout_url: session.url, client_fields: {} };
  }

  async function verifyStripeSession({ order }) {
    const get = creds('stripe');
    const secretKey = get('SECRET_KEY');
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${order.provider_order_id}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const session = await res.json();
    if (!res.ok) throw new Error(session.error?.message || 'Stripe session lookup failed');
    if (session.payment_status === 'paid') return 'paid';
    if (session.status === 'expired') return 'failed';
    return 'pending';
  }

  // Stripe signature verification without the stripe SDK: same construction
  // Stripe's own libraries use — HMAC-SHA256 over "{timestamp}.{rawBody}"
  // with the webhook signing secret, compared against the v1 signature(s)
  // in the Stripe-Signature header.
  function verifyStripeWebhookSignature(rawBody, sigHeader) {
    const crypto = require('crypto');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !sigHeader) return false;
    const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
    if (!parts.t || !parts.v1) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    return expected === parts.v1;
  }

  // ─── PayPal ──────────────────────────────────────────────────────────────
  async function paypalAccessToken() {
    const get = creds('paypal');
    const clientId = get('CLIENT_ID');
    const clientSecret = get('CLIENT_SECRET');
    if (!clientId || !clientSecret) throw new Error(`PayPal credentials not set for ${isTestMode ? 'TEST' : 'PRODUCTION'} mode`);
    const base = isTestMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error('PayPal token fetch failed');
    return { accessToken: data.access_token, base };
  }

  async function createPaypalOrder({ order, items, successUrl, cancelUrl }) {
    const { accessToken, base } = await paypalAccessToken();
    const currency = (order.currency || 'USD').toUpperCase();
    const res = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: order.id,
          custom_id: order.id,
          amount: { currency_code: currency, value: Number(order.amount).toFixed(2) },
        }],
        application_context: {
          return_url: successUrl,
          cancel_url: cancelUrl,
          user_action: 'PAY_NOW',
        },
      }),
    });
    const data = await res.json();
    const approvalUrl = data.links?.find((l) => l.rel === 'approve')?.href;
    if (!res.ok || !approvalUrl) throw new Error(data.message || `PayPal order creation failed (${res.status})`);
    return { provider_order_id: data.id, checkout_url: approvalUrl, client_fields: {} };
  }

  async function verifyPaypalOrder({ order }) {
    const { accessToken, base } = await paypalAccessToken();
    const res = await fetch(`${base}/v2/checkout/orders/${order.provider_order_id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'PayPal order lookup failed');
    if (data.status === 'COMPLETED') return 'paid';
    if (data.status === 'APPROVED') {
      // Approved but not yet captured — capture now so funds actually move.
      const captureRes = await fetch(`${base}/v2/checkout/orders/${order.provider_order_id}/capture`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });
      const captureData = await captureRes.json();
      if (captureRes.ok && captureData.status === 'COMPLETED') return 'paid';
      return 'pending';
    }
    if (data.status === 'VOIDED') return 'failed';
    return 'pending';
  }

  // PayPal webhook verification requires a round-trip to PayPal's own
  // verify-webhook-signature endpoint (there's no local HMAC scheme, unlike
  // Razorpay/Stripe) — done here rather than trusting the payload as-is.
  async function verifyPaypalWebhookSignature(rawBody, headers) {
    try {
      const { accessToken, base } = await paypalAccessToken();
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) return false;
      const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: webhookId,
          webhook_event: JSON.parse(rawBody),
        }),
      });
      const data = await res.json();
      return data.verification_status === 'SUCCESS';
    } catch {
      return false;
    }
  }

  // ─── Unified interface ───────────────────────────────────────────────────
  async function createCheckout({ provider, order, items, successUrl, cancelUrl }) {
    if (provider === 'razorpay') return createRazorpayOrder({ order, successUrl });
    if (provider === 'stripe') return createStripeSession({ order, items, successUrl, cancelUrl });
    if (provider === 'paypal') return createPaypalOrder({ order, items, successUrl, cancelUrl });
    throw new Error(`Unsupported payment provider: ${provider}`);
  }

  async function verifyPayment({ order }) {
    if (order.provider === 'razorpay') return verifyRazorpayOrder({ order });
    if (order.provider === 'stripe') return verifyStripeSession({ order });
    if (order.provider === 'paypal') return verifyPaypalOrder({ order });
    throw new Error(`Unsupported payment provider: ${order.provider}`);
  }

  function verifyWebhookSignature(provider, rawBody, headers) {
    if (provider === 'razorpay') return verifyRazorpayWebhookSignature(rawBody, headers['x-razorpay-signature']);
    if (provider === 'stripe') return verifyStripeWebhookSignature(rawBody, headers['stripe-signature']);
    if (provider === 'paypal') return verifyPaypalWebhookSignature(rawBody, headers);
    return false;
  }

  // Marks an order paid/failed in wb_orders (idempotent — safe to call from
  // both a webhook handler and a fallback poller) and returns the updated row.
  async function markOrderStatus(orderId, status) {
    const { data, error } = await supabase.from('wb_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', orderId).select().single();
    if (error) throw new Error(error.message);
    return data;
  }

  return {
    isTestMode,
    createCheckout,
    verifyPayment,
    verifyWebhookSignature,
    markOrderStatus,
  };
};
