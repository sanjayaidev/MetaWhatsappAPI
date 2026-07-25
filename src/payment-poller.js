// src/payment-poller.js — safety net for missed/delayed payment webhooks.
//
// payments-webhook.js is the primary path (provider calls us the moment a
// payment succeeds/fails), but webhooks can be missed entirely (misconfigured
// endpoint, provider-side retry exhaustion, network blip) or arrive late.
// This runs a low-frequency background sweep of orders stuck in 'pending'
// and asks the provider directly via payments.verifyPayment — the same
// on-demand check the authenticated /api/ecom/orders/:id/status endpoint
// does, just automatic instead of requiring someone to load a page.
//
// Mirrors the create → pending-row → verify/poll pattern documented at the
// top of payments.js, and the cron-based scheduler pattern in sm/scheduler.js.
const cron = require('node-cron');
const createPaymentsModule = require('./payments');
const createChannelSender = require('./channel-send');

// How far back to keep retrying a pending order before giving up. Checkout
// sessions/links don't stay valid forever on any of these providers, so
// there's no point polling a week-old abandoned cart indefinitely.
const MAX_ORDER_AGE_MS = 24 * 60 * 60 * 1000;

function startPaymentPoller(deps) {
  const { supabase } = deps;
  const payments = createPaymentsModule({ supabase });
  const sendChannelMessage = createChannelSender(deps);

  // Same lookup payments-webhook.js's handleEvent uses, so a customer gets
  // the same "payment received" confirmation message whether the webhook
  // or this fallback poller is what actually detected it.
  async function leadForOrder(order) {
    if (order.channel === 'manual' || !order.contact_id) return null;
    const column = order.channel === 'whatsapp' ? 'phone' : order.channel === 'instagram' ? 'ig_handle' : 'fb_psid';
    const { data } = await supabase.from('wb_leads')
      .select('*').eq('user_id', order.user_id).eq(column, order.contact_id).maybeSingle();
    return data || null;
  }

  async function checkOnePendingOrder(order) {
    let status;
    try {
      status = await payments.verifyPayment({ order });
    } catch (err) {
      console.error(`Payment poller: verify failed for order ${order.id} (${order.provider}):`, err.message);
      return;
    }
    if (status === 'pending') return; // still nothing to do, check again next tick

    await payments.markOrderStatus(order.id, status);
    console.log(`Payment poller: order ${order.id} resolved to '${status}' via fallback poll`);

    if (status === 'paid') {
      const lead = await leadForOrder(order);
      if (lead) {
        try {
          await sendChannelMessage({
            lead, channel: order.channel, isAutomation: true,
            body: `✅ Payment received for your order (₹${order.amount}). We'll get it ready for you shortly!`,
          });
        } catch (err) {
          // Order is still correctly marked paid even if the notify send fails.
          console.error(`Payment poller: confirmation message failed for order ${order.id}:`, err.message);
        }
      }
    }
  }

  async function tick() {
    const cutoff = new Date(Date.now() - MAX_ORDER_AGE_MS).toISOString();
    const { data: pending, error } = await supabase.from('wb_orders')
      .select('*')
      .eq('status', 'pending')
      .not('provider_order_id', 'is', null)
      .gte('created_at', cutoff);
    if (error) {
      console.error('Payment poller: failed to fetch pending orders:', error.message);
      return;
    }
    for (const order of pending || []) {
      await checkOnePendingOrder(order);
    }
  }

  // Every 2 minutes — this is only a safety net, not the primary reconciliation
  // path, so it doesn't need to poll anywhere near as tightly as a customer
  // actively watching ecom-pay.html does.
  cron.schedule('*/2 * * * *', () => {
    tick().catch((err) => console.error('Payment poller tick failed:', err.message));
  });
  console.log('⏰ Payment fallback poller started (checks every 2 minutes for stuck pending orders)');
}

module.exports = { startPaymentPoller };
