// src/payments.js — routes checkout/verification to each CLIENT'S OWN
// PaymentGatewayAPI deployment (https://github.com/sanjaymeherdev/PaymentGatewayAPI),
// instead of holding Razorpay/Stripe/PayPal/Cashfree credentials directly in
// this app's env vars. Each client (wb_ecom_settings row) has their own
// gateway_base_url + encrypted gateway_api_key, so a client's payment
// credentials/transactions never mix with another client's.
//
// This app now knows NOTHING about individual payment providers — it just
// forwards { provider, amount, name, email, ... } to whichever gateway URL
// is configured for that order's merchant, per PaymentGatewayAPI's
// generic /api/create-order and /api/verify-order contract.
//
// Usage (interface unchanged from the old per-provider version, so
// ecom.js / payments-webhook.js / payment-poller.js / server.js call sites
// do not need to change, EXCEPT verifyWebhookSignature — see note below):
//   const payments = require('./payments')({ supabase });
//   const { checkout_url, provider_order_id } = await payments.createCheckout({
//     order, items, successUrl, cancelUrl, // order.provider still selects razorpay/stripe/paypal/cashfree
//   });
//   const status = await payments.verifyPayment({ order });

const fetch = require('node-fetch');
const { decryptToken } = require('./crypto');

module.exports = function createPaymentsModule({ supabase }) {
  // ─── Per-client gateway config ────────────────────────────────────────────
  // Looked up fresh each call rather than cached, so a client rotating their
  // GATEWAY_API_KEY or switching deployments takes effect immediately.
  async function gatewayConfigFor(userId) {
    if (!userId) throw new Error('order.user_id is required to resolve a gateway config');

    const { data, error } = await supabase
      .from('wb_ecom_settings')
      .select('gateway_base_url, gateway_api_key_encrypted')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load gateway config: ${error.message}`);
    if (!data || !data.gateway_base_url || !data.gateway_api_key_encrypted) {
      throw new Error(`No payment gateway configured for merchant ${userId}. Set gateway_base_url and gateway_api_key_encrypted in wb_ecom_settings.`);
    }

    let apiKey;
    try {
      apiKey = decryptToken(data.gateway_api_key_encrypted);
    } catch (e) {
      throw new Error(`Failed to decrypt gateway_api_key for merchant ${userId}: ${e.message}`);
    }

    // Defensive: reject anything that isn't a normal https URL, so a bad
    // row in the DB can't be used to make this server call an internal/
    // non-http(s) address (SSRF via a compromised/typo'd config row).
    let base;
    try {
      base = new URL(data.gateway_base_url);
    } catch {
      throw new Error(`gateway_base_url for merchant ${userId} is not a valid URL`);
    }
    if (base.protocol !== 'https:') {
      throw new Error(`gateway_base_url for merchant ${userId} must be https`);
    }

    return { baseUrl: base.origin, apiKey };
  }

  async function gatewayFetch(userId, path, body) {
    const { baseUrl, apiKey } = await gatewayConfigFor(userId);
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Gateway request ${path} failed (${res.status})`);
    }
    return data;
  }

  // ─── Unified interface ───────────────────────────────────────────────────
  async function createCheckout({ order, items, successUrl, cancelUrl }) {
    const data = await gatewayFetch(order.user_id, '/api/create-order', {
      provider: order.provider,
      amount: order.amount,
      name: order.contact_name || 'Customer',
      email: order.contact_email || undefined,
      message: order.id,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // The gateway fires this once it independently confirms payment.
      // Treated as a trigger-to-recheck, NOT as trusted proof — see
      // payments-webhook.js, which re-verifies via /api/verify-order
      // before ever marking an order paid.
      callback_url: `${process.env.APP_BASE_URL}/api/payments/webhook/gateway`,
    });

    return {
      provider_order_id: data.order_id,
      checkout_url: data.paypal_approval_url || data.stripe_checkout_url || null,
      client_fields: {
        razorpay_key_id: data.razorpay_key_id,
        razorpay_order_id: data.razorpay_order_id,
        cashfree_payment_session_id: data.payment_session_id,
        cashfree_mode: data.mode,
      },
    };
  }

  async function verifyPayment({ order }) {
    const data = await gatewayFetch(order.user_id, '/api/verify-order', {
      order_id: order.provider_order_id,
    });
    if (data.paid === true) return 'paid';
    if (data.status === 'failed') return 'failed';
    return 'pending';
  }

  // NOTE — breaking change from the old provider-native version:
  // PaymentGatewayAPI's callback_url POST is NOT cryptographically signed
  // (see api/_lib/common.js fireCallback — plain POST, no HMAC). Anyone who
  // learns/guesses this webhook URL could POST a fake "paid" body. So this
  // no longer does per-provider signature verification (verifyRazorpaySignature
  // etc. are gone) — instead payments-webhook.js MUST treat the incoming
  // POST as only a hint to re-check, and call verifyPayment() (which hits
  // the gateway's own /api/verify-order with our GATEWAY_API_KEY) before
  // marking anything paid. See updated payments-webhook.js.
  function verifyWebhookSignature() {
    throw new Error('verifyWebhookSignature is no longer used — see payments-webhook.js, which now re-verifies via verifyPayment() instead of trusting webhook payloads.');
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
    createCheckout,
    verifyPayment,
    verifyWebhookSignature,
    markOrderStatus,
  };
};
