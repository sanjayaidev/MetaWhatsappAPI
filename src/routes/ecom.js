// src/routes/ecom.js — merchant-facing REST API for the ecom module.
// Mounted in server.js as: app.use('/api/ecom', verifyUser, ecomRouter(crmDeps));
//
// This is the merchant/frontend-facing surface (product catalog CRUD, order
// list/status, and a checkout-test endpoint). The actual bot-driven cart flow
// (customer adds items via WhatsApp/Instagram chat) calls src/ecom/cart.js
// directly, in-process, from bot-engine.js — it doesn't round-trip through
// these HTTP routes. Both paths share the same cart/order tables and the
// same src/payments.js checkout logic, so behavior stays identical whether
// the cart was built by a chat flow or by the standalone ecom frontend.
const express = require('express');
const createCartModule = require('../ecom/cart');
const createPaymentsModule = require('../payments');
const { encryptToken } = require('../crypto');

module.exports = function ecomRouter(deps) {
  const { supabase, encryptToken: depsEncryptToken, fetch: depsFetch } = deps;
  const encrypt = depsEncryptToken || encryptToken; // deps.encryptToken (crmDeps) takes priority; falls back to a direct require so this route still works if ecomRouter is ever wired up standalone
  const fetch = depsFetch || require('node-fetch');
  const cart = createCartModule({ supabase });
  const payments = createPaymentsModule({ supabase });
  const router = express.Router();

  // ── Merchant ecom settings (default payment provider, currency, bot copy) ─
  router.get('/settings', async (req, res) => {
    const { data, error } = await supabase.from('wb_ecom_settings').select('*').eq('user_id', req.user.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data || { user_id: req.user.id, default_provider: 'cashfree', currency: 'INR', catalog_greeting: "Here's what we have available:", checkout_button_label: 'Checkout' } });
  });

  router.put('/settings', async (req, res) => {
    const allowed = ['default_provider', 'currency', 'catalog_greeting', 'checkout_button_label'];
    const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    const { data, error } = await supabase.from('wb_ecom_settings')
      .upsert({ user_id: req.user.id, ...updates, updated_at: new Date().toISOString() })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data });
  });

  // ── Payment gateway onboarding wizard ────────────────────────────────
  // Same encrypt + upsert into wb_ecom_settings that scripts/onboard-client-
  // gateway.js did from the console (see that file's header comment for the
  // background) — but callable by the merchant themselves, from the UI,
  // right after they've deployed their own PaymentGatewayAPI to Vercel and
  // generated a GATEWAY_API_KEY. No server console / env-var access needed.
  //
  // GET  /gateway/status      → is a gateway connected yet? (never returns the key)
  // POST /gateway/onboard     → { gateway_base_url, gateway_api_key } — save/replace it
  // POST /gateway/test        → best-effort reachability check before saving
  // DELETE /gateway           → disconnect (e.g. before pointing at a new deployment)
  router.get('/gateway/status', async (req, res) => {
    const { data, error } = await supabase.from('wb_ecom_settings')
      .select('gateway_base_url, default_provider').eq('user_id', req.user.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({
      connected: !!data?.gateway_base_url,
      gateway_base_url: data?.gateway_base_url || null,
      default_provider: data?.default_provider || 'cashfree',
    });
  });

  // Best-effort connectivity check for the wizard's "Test Connection" step —
  // just confirms the URL is reachable and https, NOT that the API key is
  // valid or that a real charge would succeed (we don't want to fire an
  // actual test order against a live payment provider from an onboarding
  // wizard). Full validation happens for real the first time a customer
  // actually checks out.
  router.post('/gateway/test', async (req, res) => {
    const { gateway_base_url } = req.body || {};
    let base;
    try { base = new URL(gateway_base_url); } catch { return res.status(400).json({ error: 'Not a valid URL' }); }
    if (base.protocol !== 'https:') return res.status(400).json({ error: 'gateway_base_url must be https' });
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const result = await fetch(base.origin, { method: 'GET', signal: controller.signal }).finally(() => clearTimeout(timeout));
      // Any HTTP response at all (even a 404 on "/") means the deployment is
      // up and reachable — that's all this step is meant to confirm.
      res.json({ reachable: true, status: result.status });
    } catch (err) {
      res.json({ reachable: false, error: err.name === 'AbortError' ? 'Timed out reaching that URL' : err.message });
    }
  });

  router.post('/gateway/onboard', async (req, res) => {
    const { gateway_base_url, gateway_api_key } = req.body || {};
    if (!gateway_base_url || !gateway_api_key) {
      return res.status(400).json({ error: 'gateway_base_url and gateway_api_key are required' });
    }
    let base;
    try { base = new URL(gateway_base_url); } catch { return res.status(400).json({ error: 'gateway_base_url is not a valid URL' }); }
    if (base.protocol !== 'https:') return res.status(400).json({ error: 'gateway_base_url must be https' });

    let encrypted;
    try {
      encrypted = encrypt(gateway_api_key);
    } catch (err) {
      // Almost always means TOKEN_ENCRYPTION_KEY isn't set/valid on this
      // deployment — a server misconfiguration, not something the merchant
      // filling out the wizard can fix, so say so plainly instead of a
      // generic 500.
      return res.status(500).json({ error: `Could not encrypt the gateway key — check TOKEN_ENCRYPTION_KEY is configured on the server (${err.message})` });
    }

    const { data, error } = await supabase.from('wb_ecom_settings')
      .upsert({
        user_id: req.user.id,
        gateway_base_url: base.origin,
        gateway_api_key_encrypted: encrypted,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select('gateway_base_url, default_provider, currency').single();
    if (error) return res.status(500).json({ error: error.message });

    // Plaintext key is never stored or echoed back anywhere past this point —
    // same guarantee the console script gave.
    res.json({ ok: true, settings: data });
  });

  router.delete('/gateway', async (req, res) => {
    const { error } = await supabase.from('wb_ecom_settings')
      .update({ gateway_base_url: null, gateway_api_key_encrypted: null, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ── Products ──────────────────────────────────────────────────────────
  router.get('/products', async (req, res) => {
    const { data, error } = await supabase.from('wb_products')
      .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ products: data || [] });
  });

  router.post('/products', async (req, res) => {
    const { name, description = '', price, currency = 'INR', image_url, sku, stock_qty = null, is_active = true } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (price === undefined || Number(price) < 0) return res.status(400).json({ error: 'price must be a non-negative number' });
    const { data, error } = await supabase.from('wb_products')
      .insert({ user_id: req.user.id, name, description, price, currency, image_url, sku, stock_qty, is_active })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ product: data });
  });

  router.put('/products/:id', async (req, res) => {
    const allowed = ['name', 'description', 'price', 'currency', 'image_url', 'sku', 'stock_qty', 'is_active'];
    const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('wb_products')
      .update(updates).eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: data });
  });

  router.delete('/products/:id', async (req, res) => {
    const { error } = await supabase.from('wb_products').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ── Cart (mainly for testing/preview from the ecom frontend — the real
  // customer-facing cart is built through chat, via src/ecom/cart.js) ────
  router.get('/cart', async (req, res) => {
    const { channel, contact_id } = req.query;
    if (!channel || !contact_id) return res.status(400).json({ error: 'channel and contact_id are required' });
    try {
      const summary = await cart.getSummary(req.user.id, channel, contact_id);
      res.json(summary);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/cart/items', async (req, res) => {
    const { channel, contact_id, contact_name = '', product_id, quantity = 1 } = req.body || {};
    if (!channel || !contact_id || !product_id) return res.status(400).json({ error: 'channel, contact_id, and product_id are required' });
    try {
      const item = await cart.addItem(req.user.id, channel, contact_id, product_id, quantity, contact_name);
      res.json({ item });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/cart/items/:cartItemId', async (req, res) => {
    const { cart_id } = req.query;
    if (!cart_id) return res.status(400).json({ error: 'cart_id is required' });
    try {
      await cart.removeItem(cart_id, req.params.cartItemId);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Checkout ─────────────────────────────────────────────────────────
  // Converts the open cart into an order, then creates a provider checkout
  // session for it. Frontend redirects the customer to `checkout_url`
  // (Stripe/PayPal) or uses `client_fields` to mount Razorpay Checkout.js.
  router.post('/checkout', async (req, res) => {
    const { channel, contact_id, provider, currency = 'INR', success_url, cancel_url } = req.body || {};
    if (!channel || !contact_id || !provider) return res.status(400).json({ error: 'channel, contact_id, and provider are required' });
    if (!['razorpay', 'stripe', 'paypal', 'cashfree'].includes(provider)) return res.status(400).json({ error: 'provider must be razorpay, stripe, paypal, or cashfree' });

    try {
      const { order, items } = await cart.checkoutCart(req.user.id, channel, contact_id, currency);
      // provider/user_id must be on `order` before calling createCheckout —
      // payments.js now resolves the merchant's own gateway deployment from
      // order.user_id (wb_ecom_settings.gateway_base_url), and order.provider
      // instead of taking a separate top-level `provider` arg.
      const checkoutResult = await payments.createCheckout({
        order: { ...order, provider, user_id: req.user.id }, items,
        successUrl: success_url || `${req.protocol}://${req.get('host')}/ecom/thank-you?order_id=${order.id}`,
        cancelUrl: cancel_url || `${req.protocol}://${req.get('host')}/ecom`,
      });
      await supabase.from('wb_orders')
        .update({ provider, provider_order_id: checkoutResult.provider_order_id })
        .eq('id', order.id);

      res.json({
        order_id: order.id,
        provider,
        checkout_url: checkoutResult.checkout_url,
        client_fields: checkoutResult.client_fields || {},
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Lets the frontend poll for status instead of waiting on a webhook only —
  // same "verify" pattern as donationalert's thankyou.html polling.
  router.get('/orders/:id/status', async (req, res) => {
    const { data: order, error } = await supabase.from('wb_orders')
      .select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (error || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending' || !order.provider_order_id) return res.json({ status: order.status });

    try {
      const status = await payments.verifyPayment({ order });
      if (status !== 'pending') await payments.markOrderStatus(order.id, status);
      res.json({ status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Merchant order management ────────────────────────────────────────
  router.get('/orders', async (req, res) => {
    const { status } = req.query;
    let query = supabase.from('wb_orders').select('*, wb_order_items(*)').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ orders: data || [] });
  });

  router.put('/orders/:id', async (req, res) => {
    const { status } = req.body || {};
    if (!['pending', 'paid', 'failed', 'cancelled', 'fulfilled'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const { data, error } = await supabase.from('wb_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: data });
  });

  return router;
};
