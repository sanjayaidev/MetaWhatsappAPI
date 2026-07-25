-- Adds Cashfree as a 4th supported payment provider alongside Razorpay,
-- Stripe, and PayPal. The provider columns on wb_orders and wb_ecom_settings
-- were created with CHECK constraints hardcoding the original 3 providers
-- (see migrations/002 and 003) — without this migration, any attempt to
-- save an order or setting with provider = 'cashfree' fails at the DB layer
-- even though the application code (src/payments.js) now supports it.
--
-- Uses Postgres's default auto-generated constraint names
-- (<table>_<column>_check). If your instance renamed these constraints,
-- adjust the DROP CONSTRAINT names below to match.

alter table wb_orders
  drop constraint if exists wb_orders_provider_check;
alter table wb_orders
  add constraint wb_orders_provider_check
  check (provider in ('razorpay', 'stripe', 'paypal', 'cashfree'));

alter table wb_ecom_settings
  drop constraint if exists wb_ecom_settings_default_provider_check;
alter table wb_ecom_settings
  add constraint wb_ecom_settings_default_provider_check
  check (default_provider in ('razorpay', 'stripe', 'paypal', 'cashfree'));
