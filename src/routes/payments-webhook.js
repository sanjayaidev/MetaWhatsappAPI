// src/routes/payments-webhook.js — public endpoint our own PaymentGatewayAPI
// deployment(s) call on payment success/failure. Mounted WITHOUT verifyUser
// (the gateway has no user session — order_id in the payload is how we find
// the merchant):
//   app.use('/api/payments/webhook', paymentsWebhookRouter(crmDeps));
//
// SECURITY — this callback is NOT signed by PaymentGatewayAPI (see its
// api/_lib/common.js fireCallback: a plain unsigned POST). That means this
// endpoint's URL is effectively public: anyone who learns/guesses it could
// POST a fake { paid: true, order_id: "..." } body. So the payload here is
// treated as ONLY a hint to re-check — we never mark an order paid based on
// what this request body claims. Instead, on any hit we call back to that
// order's own gateway deployment via payments.verifyPayment(), which is
// authenticated with our GATEWAY_API_KEY, and trust ONLY that response.
// This also naturally handles routing to the right client's gateway, since
// verifyPayment() looks up order.user_id -> wb_ecom_settings itself.
const express = require('express');
const createPaymentsModule = require('../payments');
const createChannelSender = require('../channel-send');

module.exports = function paymentsWebhookRouter(deps) {
  const { supabase } = deps;
  const payments = createPaymentsModule({ supabase });
  const sendChannelMessage = createChannelSender(deps);
  const router = express.Router();

  async function leadForOrder(order) {
    if (order.channel === 'manual' || !order.contact_id) return null;
    const column = order.channel === 'whatsapp' ? 'phone' : order.channel === 'instagram' ? 'ig_handle' : 'fb_psid';
    const { data } = await supabase.from('wb_leads').select('*').eq('user_id', order.user_id).eq(column, order.contact_id).maybeSingle();
    return data || null;
  }

  async function markPaidAndNotify(order) {
    await payments.markOrderStatus(order.id, 'paid');
    const lead = await leadForOrder(order);
    if (lead) {
      try {
        await sendChannelMessage({
          lead, channel: order.channel, isAutomation: true,
          body: `✅ Payment received for your order (₹${order.amount}). We'll get it ready for you shortly!`,
        });
      } catch (_) { /* order is still marked paid even if the notify send fails */ }
    }
  }

  // Single generic route for all providers — PaymentGatewayAPI's callback_url
  // payload always has the same shape regardless of provider (see its README:
  // "Webhook payload (callback_url)"), and order_id here is OUR wb_orders id
  // (we pass it as `message` at create-order time — see payments.js).
  router.post('/gateway', async (req, res) => {
    // Always 200 quickly — this is just a "go check" nudge, not the source
    // of truth, so there's nothing to reject at this layer beyond basic shape.
    const orderId = req.body?.order_id || req.body?.message;
    if (!orderId) return res.status(200).json({ ok: true });

    const { data: order, error } = await supabase.from('wb_orders').select('*').eq('id', orderId).single();
    if (error || !order) return res.status(200).json({ ok: true });
    if (order.status === 'paid') return res.status(200).json({ ok: true }); // already processed, webhooks can arrive more than once

    let status;
    try {
      status = await payments.verifyPayment({ order }); // authenticated re-check, ignores req.body's claims entirely
    } catch (e) {
      console.error('[payments-webhook] verifyPayment failed', order.id, e.message);
      return res.status(200).json({ ok: true }); // poller (src/payment-poller.js) will retry
    }

    if (status === 'paid') await markPaidAndNotify(order);
    else if (status === 'failed') await payments.markOrderStatus(order.id, 'failed');
    // 'pending' -> leave as-is; poller and/or a later webhook hit will resolve it

    res.status(200).json({ ok: true });
  });

  return router;
};
