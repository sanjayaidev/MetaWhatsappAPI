// src/ecom/cart.js — channel-agnostic cart operations on wb_carts/wb_cart_items.
// Used two ways:
//   1. Directly, in-process, by the WhatsApp/Instagram bot flow (bot-engine.js)
//      when a customer taps "Add to cart" / "Checkout" in a chat.
//   2. Wrapped in REST endpoints (src/routes/ecom.js) for the standalone ecom
//      frontend and for testing from the Dashboard/CRM.
// Keeping the logic here (not duplicated in the router) means both callers
// get identical cart behavior for free.

module.exports = function createCartModule({ supabase }) {
  async function getOrCreateCart(userId, channel, contactId, contactName = '') {
    const { data: existing } = await supabase.from('wb_carts')
      .select('*').eq('user_id', userId).eq('channel', channel).eq('contact_id', contactId)
      .eq('status', 'open').maybeSingle();
    if (existing) return existing;

    const { data, error } = await supabase.from('wb_carts')
      .insert({ user_id: userId, channel, contact_id: contactId, contact_name: contactName })
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function addItem(userId, channel, contactId, productId, quantity = 1, contactName = '') {
    const { data: product, error: productError } = await supabase.from('wb_products')
      .select('*').eq('id', productId).eq('user_id', userId).eq('is_active', true).single();
    if (productError || !product) throw new Error('Product not found or inactive');
    if (product.stock_qty !== null && product.stock_qty < quantity) {
      throw new Error(`Only ${product.stock_qty} left in stock`);
    }

    const cart = await getOrCreateCart(userId, channel, contactId, contactName);

    // If this product is already in the cart, bump the quantity instead of
    // inserting a duplicate row.
    const { data: existingItem } = await supabase.from('wb_cart_items')
      .select('*').eq('cart_id', cart.id).eq('product_id', productId).maybeSingle();

    if (existingItem) {
      const { data, error } = await supabase.from('wb_cart_items')
        .update({ quantity: existingItem.quantity + quantity })
        .eq('id', existingItem.id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    const { data, error } = await supabase.from('wb_cart_items')
      .insert({ cart_id: cart.id, product_id: productId, name: product.name, unit_price: product.price, quantity })
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function removeItem(cartId, cartItemId) {
    const { error } = await supabase.from('wb_cart_items').delete().eq('id', cartItemId).eq('cart_id', cartId);
    if (error) throw new Error(error.message);
  }

  async function getSummary(userId, channel, contactId) {
    const { data: cart } = await supabase.from('wb_carts')
      .select('*').eq('user_id', userId).eq('channel', channel).eq('contact_id', contactId)
      .eq('status', 'open').maybeSingle();
    if (!cart) return { cart: null, items: [], total: 0 };

    const { data: items, error } = await supabase.from('wb_cart_items').select('*').eq('cart_id', cart.id);
    if (error) throw new Error(error.message);
    const total = (items || []).reduce((sum, i) => sum + Number(i.unit_price) * i.quantity, 0);
    return { cart, items: items || [], total };
  }

  async function clearCart(cartId) {
    const { error } = await supabase.from('wb_cart_items').delete().eq('cart_id', cartId);
    if (error) throw new Error(error.message);
  }

  // Converts an open cart into a wb_orders row + wb_order_items snapshot, and
  // marks the cart checked_out. Does NOT touch payments — src/payments.js
  // takes the returned order and creates the actual checkout session.
  async function checkoutCart(userId, channel, contactId, currency = 'INR') {
    const { cart, items, total } = await getSummary(userId, channel, contactId);
    if (!cart || !items.length) throw new Error('Cart is empty');

    const { data: order, error: orderError } = await supabase.from('wb_orders')
      .insert({
        user_id: userId, cart_id: cart.id, channel, contact_id: contactId,
        contact_name: cart.contact_name, status: 'pending', amount: total, currency,
      }).select().single();
    if (orderError) throw new Error(orderError.message);

    const orderItems = items.map((i) => ({
      order_id: order.id, product_id: i.product_id, name: i.name,
      unit_price: i.unit_price, quantity: i.quantity, subtotal: Number(i.unit_price) * i.quantity,
    }));
    const { error: itemsError } = await supabase.from('wb_order_items').insert(orderItems);
    if (itemsError) throw new Error(itemsError.message);

    await supabase.from('wb_carts').update({ status: 'checked_out' }).eq('id', cart.id);

    return { order, items: orderItems };
  }

  return { getOrCreateCart, addItem, removeItem, getSummary, clearCart, checkoutCart };
};
