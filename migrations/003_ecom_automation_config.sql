-- Adds two things needed by the ecom automation builder:
--   1. wb_bot_rules.action_config — a generic jsonb bucket for action-type-
--      specific extra config, so new action types (ecom_catalog, ecom_checkout)
--      don't each need their own dedicated columns. action_type/action_template_id/
--      ai_prompt/ai_fallback (see src/routes/bot-builder.js) are left untouched;
--      this is additive only.
--   2. wb_ecom_settings — one row per merchant: default payment provider,
--      currency, and the small bits of copy the bot sends during checkout.

alter table wb_bot_rules add column if not exists action_config jsonb not null default '{}'::jsonb;

create table if not exists wb_ecom_settings (
  user_id uuid primary key references wb_profiles(id) on delete cascade,
  default_provider text not null default 'stripe' check (default_provider in ('razorpay', 'stripe', 'paypal')),
  currency text not null default 'INR',
  catalog_greeting text not null default 'Here''s what we have available:',
  checkout_button_label text not null default 'Checkout',
  updated_at timestamptz not null default now()
);

alter table wb_ecom_settings enable row level security;
drop policy if exists "Users manage their own ecom settings" on wb_ecom_settings;
create policy "Users manage their own ecom settings"
  on wb_ecom_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
