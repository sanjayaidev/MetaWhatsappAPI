-- Run this against your Postgres project (psql $DATABASE_URL -f ...) before
-- deploying the server.js / src/routes/ecom.js changes in fix.patch.
--
-- Adds the ecom module's data model: a merchant's product catalog, a
-- server-side cart per (channel, contact) so WhatsApp/Instagram/Facebook
-- conversations can accumulate items across messages, and orders/order_items
-- once a cart is checked out. This is intentionally channel-agnostic — the
-- same tables back the WhatsApp bot flow, the Instagram/Facebook DM flow,
-- and the standalone ecom frontend/dashboard.

create table if not exists wb_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wb_profiles(id) on delete cascade,
  name text not null,
  description text default '',
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'INR',
  image_url text,
  sku text,
  stock_qty integer, -- null = unlimited/untracked stock
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wb_products_user_active
  on wb_products (user_id, is_active, created_at desc);

alter table wb_products enable row level security;
drop policy if exists "Users manage their own products" on wb_products;
create policy "Users manage their own products"
  on wb_products for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- One open cart per (merchant, channel, contact). `contact_id` is whichever
-- identifier that channel uses to address the customer: WhatsApp phone
-- number, Instagram-scoped id (IGSID), or Facebook PSID — the same values
-- already stored on wb_leads.phone / ig_handle / fb_psid.
create table if not exists wb_carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wb_profiles(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'instagram', 'facebook')),
  contact_id text not null,
  contact_name text default '',
  status text not null default 'open' check (status in ('open', 'checked_out', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one OPEN cart per merchant+channel+contact at a time. Checked-out /
-- abandoned carts are left in place for history, so this is a partial index
-- rather than a plain unique constraint.
create unique index if not exists idx_wb_carts_open_unique
  on wb_carts (user_id, channel, contact_id)
  where status = 'open';

alter table wb_carts enable row level security;
drop policy if exists "Users manage their own carts" on wb_carts;
create policy "Users manage their own carts"
  on wb_carts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists wb_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references wb_carts(id) on delete cascade,
  product_id uuid not null references wb_products(id) on delete restrict,
  -- Snapshotted at add-to-cart time so a later price edit doesn't retroactively
  -- change what's already in someone's cart.
  name text not null,
  unit_price numeric(12,2) not null,
  quantity integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_wb_cart_items_cart
  on wb_cart_items (cart_id);

alter table wb_cart_items enable row level security;
drop policy if exists "Users manage their own cart items" on wb_cart_items;
create policy "Users manage their own cart items"
  on wb_cart_items for all
  using (exists (select 1 from wb_carts c where c.id = cart_id and c.user_id = auth.uid()))
  with check (exists (select 1 from wb_carts c where c.id = cart_id and c.user_id = auth.uid()));

create table if not exists wb_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wb_profiles(id) on delete cascade,
  cart_id uuid references wb_carts(id) on delete set null,
  channel text not null check (channel in ('whatsapp', 'instagram', 'facebook', 'manual')),
  contact_id text,
  contact_name text default '',
  contact_phone text,
  contact_email text,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'cancelled', 'fulfilled')),
  amount numeric(12,2) not null,
  currency text not null default 'INR',
  provider text check (provider in ('razorpay', 'stripe', 'paypal')),
  provider_order_id text, -- Razorpay order id / Stripe Checkout Session id / PayPal order id
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wb_orders_user_status
  on wb_orders (user_id, status, created_at desc);

create index if not exists idx_wb_orders_provider_order_id
  on wb_orders (provider_order_id);

alter table wb_orders enable row level security;
drop policy if exists "Users manage their own orders" on wb_orders;
create policy "Users manage their own orders"
  on wb_orders for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists wb_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references wb_orders(id) on delete cascade,
  product_id uuid references wb_products(id) on delete set null,
  name text not null,
  unit_price numeric(12,2) not null,
  quantity integer not null check (quantity > 0),
  subtotal numeric(12,2) not null
);

create index if not exists idx_wb_order_items_order
  on wb_order_items (order_id);

alter table wb_order_items enable row level security;
drop policy if exists "Users manage their own order items" on wb_order_items;
create policy "Users manage their own order items"
  on wb_order_items for all
  using (exists (select 1 from wb_orders o where o.id = order_id and o.user_id = auth.uid()))
  with check (exists (select 1 from wb_orders o where o.id = order_id and o.user_id = auth.uid()));
