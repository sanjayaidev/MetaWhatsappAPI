// src/routes/payments-webhook.js — public endpoint providers call directly
// on payment success/failure. Mounted WITHOUT verifyUser (the provider has
// no user session — the order id in the payload is how we find the merchant):
//   app.use('/api/payments/webhook', paymentsWebhookRouter(crmDeps));
//
// Signature verification needs the exact raw request bytes, not the
// re-serialized parsed body. server.js's global express.json() already
// captures that via `verify: (req,_res,buf) => { req.rawBody = buf }` (used
// elsewhere for the same reason), so these handlers read req.rawBody for
// signature checks and req.body (already-parsed JSON) for the payload.

//
// On a verified "paid" event, this both updates wb_orders AND sends the
// customer a confirmation message back on the same channel (WhatsApp/
// Instagram/Facebook) their order came in on, using the existing
// channel-send.js sender + wb_leads lookup — so a merchant using the
// ecom module, the CRM, or the chatbot builder all get this for free.
const express = require('express');
const createPaymentsModule = require('../payments');
const createChannelSender = require('../channel-send');

module.exports = function paymentsWebhookRouter(deps) {
  const { supabase } = deps;
  const payments = createPaymentsModule({ supabase });
  const sendChannelMessage = createChannelSender(deps);
  const router = express.Router();

  // Finds the wb_leads row for this order's channel+contact so we know how
  // to address the customer (phone / ig_handle / fb_psid) via channel-send.js,
  // which expects a "lead"-shaped object.
  async function leadForOrder(order) {
    if (order.channel === 'manual' || !order.contact_id) return null;
    const column = order.channel === 'whatsapp' ? 'phone' : order.channel === 'instagram' ? 'ig_handle' : 'fb_psid';
    const { data } = await supabase.from('wb_leads').select('*').eq('user_id', order.user_id).eq(column, order.contact_id).maybeSingle();
    return data || null;
  }

  async function handleEvent(provider, orderId, resolvedStatus) {
    const { data: order, error } = await supabase.from('wb_orders').select('*').eq('id', orderId).single();
    if (error || !order) return;
    if (order.status === resolvedStatus) return; // already processed — webhooks can arrive more than once

    await payments.markOrderStatus(order.id, resolvedStatus);

    if (resolvedStatus === 'paid') {
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
  }

  // Razorpay: payload includes payload.payment.entity.order_id and event type.
  router.post('/razorpay', async (req, res) => {
    const valid = payments.verifyWebhookSignature('razorpay', req.rawBody, req.headers);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });
    const payload = req.body;
    const providerOrderId = payload.payload?.payment?.entity?.order_id;
    if (!providerOrderId) return res.status(200).json({ ok: true }); // nothing to reconcile

    const { data: order } = await supabase.from('wb_orders').select('id').eq('provider_order_id', providerOrderId).single();
    if (!order) return res.status(200).json({ ok: true });

    const status = payload.event === 'payment.captured' ? 'paid' : payload.event === 'payment.failed' ? 'failed' : null;
    if (status) await handleEvent('razorpay', order.id, status);
    res.status(200).json({ ok: true });
  });

  // Stripe: event.data.object.client_reference_id carries our own order id.
  router.post('/stripe', async (req, res) => {
    const valid = payments.verifyWebhookSignature('stripe', req.rawBody, req.headers);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });
    const event = req.body;
    const orderId = event.data?.object?.client_reference_id;
    if (!orderId) return res.status(200).json({ ok: true });

    if (event.type === 'checkout.session.completed') await handleEvent('stripe', orderId, 'paid');
    else if (event.type === 'checkout.session.expired') await handleEvent('stripe', orderId, 'failed');
    res.status(200).json({ ok: true });
  });

  // PayPal: event.resource.custom_id (or purchase_units[0].custom_id) carries our order id.
  router.post('/paypal', async (req, res) => {
    const valid = await payments.verifyWebhookSignature('paypal', req.rawBody, req.headers);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });
    const event = req.body;
    const orderId = event.resource?.custom_id || event.resource?.purchase_units?.[0]?.custom_id;
    if (!orderId) return res.status(200).json({ ok: true });

    if (event.event_type === 'CHECKOUT.ORDER.APPROVED' || event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      await handleEvent('paypal', orderId, 'paid');
    } else if (event.event_type === 'CHECKOUT.ORDER.VOIDED' || event.event_type === 'PAYMENT.CAPTURE.DENIED') {
      await handleEvent('paypal', orderId, 'failed');
    }
    res.status(200).json({ ok: true });
  });

  return router;
};
