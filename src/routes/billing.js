// src/routes/billing.js — CRM module subscription status + checkout kickoff.
// Order/session creation is stubbed per-provider: wiring a real Razorpay
// order, Stripe Checkout Session, or PayPal order requires that provider's
// SDK + API keys, which aren't in this repo yet. The shape (routes, request/
// response contract, wb_subscriptions writes) is real — swap the TODO block
// in createCheckout() for the real SDK call per provider when you add keys.
const express = require('express');

module.exports = function billingRouter(deps) {
  const { supabase, verifyUser } = deps;
  const router = express.Router();

  const PLANS = { crm_monthly: { amount: 99900, currency: 'INR', label: 'CRM Monthly' } }; // amount in paise

  router.get('/subscription', verifyUser, async (req, res) => {
    const { data, error } = await supabase.from('wb_subscriptions').select('*')
      .eq('user_id', req.user.id).eq('status', 'active').order('created_at', { ascending: false }).limit(1).single();
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json({ subscription: data || null });
  });

  router.post('/subscribe', verifyUser, async (req, res) => {
    const { provider, plan = 'crm_monthly' } = req.body || {};
    if (!['razorpay', 'stripe', 'paypal'].includes(provider)) return res.status(400).json({ error: 'provider must be razorpay, stripe, or paypal' });
    if (!PLANS[plan]) return res.status(400).json({ error: `Unknown plan: ${plan}` });

    const { data: pendingSub, error } = await supabase.from('wb_subscriptions')
      .insert({ user_id: req.user.id, plan, provider, status: 'pending' }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // TODO: replace with real provider checkout creation, e.g.:
    //   razorpay: await razorpayClient.orders.create({ amount, currency, receipt: pendingSub.id })
    //   stripe:   await stripeClient.checkout.sessions.create({ ... success_url, cancel_url })
    //   paypal:   await paypalClient.orders.create({ ... })
    // then update pendingSub with provider_subscription_id and return the real checkout_url.
    return res.status(501).json({
      error: `${provider} checkout isn't wired up yet — add ${provider.toUpperCase()}_* API keys and implement createCheckout() in src/routes/billing.js`,
      subscription_id: pendingSub.id
    });
  });

  // POST /api/billing/webhook/:provider — provider calls this on payment success/failure/renewal.
  // TODO: verify each provider's webhook signature before trusting the body.
  router.post('/webhook/:provider', express.raw({ type: '*/*' }), async (req, res) => {
    // Stubbed: once wired, parse req.body per-provider, find the matching
    // wb_subscriptions row (by provider_subscription_id), and update status/current_period_end.
    res.status(501).json({ error: `${req.params.provider} webhook handling not implemented yet` });
  });

  return router;
};
