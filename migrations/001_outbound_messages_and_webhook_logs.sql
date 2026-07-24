-- Run this against your Supabase project (SQL editor or `psql $DATABASE_URL -f`)
-- before deploying the server.js changes in fix.patch. Two new tables:
--
--   wb_outbound_messages — every message WE send (AI auto-reply, bot-builder
--   rule, dashboard template auto-reply, or a human agent's manual reply).
--   Previously nothing sent this way was ever persisted, so the conversation
--   view had no way to show it.
--
--   wb_webhook_logs — a raw audit trail of every /webhook POST Meta sends,
--   valid or signature-rejected, for debugging delivery issues.

create table if not exists wb_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wb_profiles(id) on delete cascade,
  wa_account_id uuid references wa_accounts(id) on delete set null,
  phone text not null,
  contact_name text default '',
  message_type text default 'text',
  message_body text default '',
  wa_message_id text,
  source text not null check (source in ('manual', 'ai_auto_reply', 'template_auto_reply', 'bot_builder')),
  created_at timestamptz not null default now()
);

create index if not exists idx_wb_outbound_messages_user_phone
  on wb_outbound_messages (user_id, phone, created_at desc);

create index if not exists idx_wb_outbound_messages_wa_message_id
  on wb_outbound_messages (wa_message_id);

alter table wb_outbound_messages enable row level security;

-- Service-role client (used by server.js) bypasses RLS entirely, but add a
-- baseline "own rows only" policy in case this table is ever queried with
-- an anon/user-scoped key (e.g. directly from a future client-side integration).
drop policy if exists "Users can read their own outbound messages" on wb_outbound_messages;
create policy "Users can read their own outbound messages"
  on wb_outbound_messages for select
  using (auth.uid() = user_id);

create table if not exists wb_webhook_logs (
  id uuid primary key default gen_random_uuid(),
  waba_id text,
  object_type text,
  fields text[] default '{}',
  signature_valid boolean not null default true,
  reject_reason text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_wb_webhook_logs_created_at
  on wb_webhook_logs (created_at desc);

create index if not exists idx_wb_webhook_logs_waba_id
  on wb_webhook_logs (waba_id);

-- No RLS needed here — this table is only ever written/read by the
-- service-role client, never exposed to end users.
