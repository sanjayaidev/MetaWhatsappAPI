-- 009_public_inbox.sql
-- Login-free, read-only inbox page protected by a revocable password (?pass=...).
--
-- 1. wb_public_inbox_keys : one row per shared password (only its SHA-256 hash is stored).
-- 2. wb_public_inbox      : VIEW over wb_inbound_messages. Shows rows ONLY while the
--                           owner has at least one non-revoked key, so revoking the
--                           key empties the view at the database level too.
--
-- Both are intentionally NOT row-level-secured, but anon/authenticated are REVOKED so
-- the (public) Supabase anon key can never read them via PostgREST. Only the
-- service-role client in server.js can.

create table if not exists wb_public_inbox_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wb_profiles(id) on delete cascade,
  label text default '',
  pass_hash text not null unique,
  show_phone boolean not null default false,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_wb_public_inbox_keys_user
  on wb_public_inbox_keys (user_id) where revoked_at is null;

alter table wb_public_inbox_keys disable row level security;

create or replace view wb_public_inbox as
  select m.id,
         m.user_id,
         m.phone,
         m.contact_name,
         m.message_type,
         m.message_body,
         m.created_at
  from wb_inbound_messages m
  where exists (
    select 1 from wb_public_inbox_keys k
    where k.user_id = m.user_id and k.revoked_at is null
  );

revoke all on wb_public_inbox_keys from anon, authenticated;
revoke all on wb_public_inbox from anon, authenticated;
grant select on wb_public_inbox to service_role;
grant all on wb_public_inbox_keys to service_role;
