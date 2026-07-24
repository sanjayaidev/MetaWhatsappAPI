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

module.exports = function ecomRouter(deps) {
  const { supabase } = deps;
  const cart = createCartModule({ supabase });
  const payments = createPaymentsModule({ supabase });
  const router = express.Router();

  // ── Merchant ecom settings (default payment provider, currency, bot copy) ─
  router.get('/settings', async (req, res) => {
    const { data, error } = await supabase.from('wb_ecom_settings').select('*').eq('user_id', req.user.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data || { user_id: req.user.id, default_provider: 'stripe', currency: 'INR', catalog_greeting: "Here's what we have available:", checkout_button_label: 'Checkout' } });
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
    if (!['razorpay', 'stripe', 'paypal'].includes(provider)) return res.status(400).json({ error: 'provider must be razorpay, stripe, or paypal' });

    try {
      const { order, items } = await cart.checkoutCart(req.user.id, channel, contact_id, currency);
      const checkoutResult = await payments.createCheckout({
        provider, order, items,
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
