-- 012_campaign_logs_and_scoped_inbox.sql
-- Safe to run more than once. Run in the Supabase SQL editor BEFORE deploying
-- the matching server.js / public-inbox.js / dashboard.html / inbox.html changes.
--
-- What this fixes
--   1. wb_campaign_logs "unique constraint" errors. The server used to call
--      upsert(..., { onConflict: 'wa_message_id' }). That needs a UNIQUE
--      constraint/index on exactly wa_message_id; if it is missing Postgres
--      answers 42P10, and if a different unique key (e.g. queue_id) already
--      exists you get 23505. The server now no longer depends on ON CONFLICT,
--      but this migration also removes duplicates and installs the one unique
--      index the data model really wants.
--   2. Full message text per recipient (wb_campaign_logs / wb_send_queue).
--   3. 'campaign' as a legal wb_outbound_messages.source.
--   4. Campaign-scoped public inbox links + the matching lookup function.
--   5. Optional backfill of voice-note media ids that were stored without one.

-- ---------------------------------------------------------------------------
-- 1 + 2. wb_campaign_logs
-- ---------------------------------------------------------------------------
create table if not exists public.wb_campaign_logs (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid,
  queue_id        uuid,
  wa_message_id   text,
  delivery_status text default 'sent',
  created_at      timestamptz not null default now()
);

alter table public.wb_campaign_logs
  add column if not exists phone         text,
  add column if not exists contact_name  text,
  add column if not exists template_name text,
  add column if not exists message_body  text,
  add column if not exists error_reason  text,
  add column if not exists sent_at       timestamptz,
  add column if not exists delivered_at  timestamptz,
  add column if not exists read_at       timestamptz,
  add column if not exists updated_at    timestamptz default now();

-- A delivery webhook can arrive before the send loop has written its row, so
-- these must be nullable or that insert fails with 23502.
alter table public.wb_campaign_logs alter column campaign_id drop not null;
alter table public.wb_campaign_logs alter column queue_id    drop not null;

-- Remove duplicate rows per wa_message_id (keep the newest one) so the unique
-- index below can be created. ctid is used so no assumption is made about the PK.
delete from public.wb_campaign_logs a
using public.wb_campaign_logs b
where a.wa_message_id is not null
  and a.wa_message_id = b.wa_message_id
  and a.ctid <> b.ctid
  and (coalesce(a.updated_at, a.created_at), a.ctid) < (coalesce(b.updated_at, b.created_at), b.ctid);

-- Plain (non-partial) unique index: NULL wa_message_id (failed sends) stay
-- unlimited because NULL <> NULL, same trick as migration 006.
create unique index if not exists idx_wb_campaign_logs_wa_message_id_unique
  on public.wb_campaign_logs (wa_message_id);

create index if not exists idx_wb_campaign_logs_campaign
  on public.wb_campaign_logs (campaign_id);

create index if not exists idx_wb_campaign_logs_queue
  on public.wb_campaign_logs (queue_id);

-- ---------------------------------------------------------------------------
-- wb_send_queue: keep the rendered message + Meta's canonical wa_id
-- ---------------------------------------------------------------------------
alter table public.wb_send_queue
  add column if not exists message_body text,
  add column if not exists wa_id        text;

create index if not exists idx_wb_send_queue_campaign_status
  on public.wb_send_queue (campaign_id, status);

create index if not exists idx_wb_send_queue_wa_message_id
  on public.wb_send_queue (wa_message_id);

-- ---------------------------------------------------------------------------
-- 3. wb_outbound_messages.source may now be 'campaign'
-- ---------------------------------------------------------------------------
alter table public.wb_outbound_messages
  add column if not exists campaign_id uuid;

alter table public.wb_outbound_messages drop constraint if exists wb_outbound_messages_source_check;
alter table public.wb_outbound_messages
  add constraint wb_outbound_messages_source_check
  check (source in ('manual', 'ai_auto_reply', 'template_auto_reply', 'bot_builder', 'campaign'));

-- ---------------------------------------------------------------------------
-- 4. Campaign-scoped public inbox
-- ---------------------------------------------------------------------------
-- NULL campaign_id = old behaviour (all inbound messages for the owner).
-- No foreign key on purpose: an ON DELETE SET NULL would silently turn a
-- scoped link into an unscoped one. The server fails closed instead (a key
-- whose campaign no longer exists shows nothing).
alter table public.wb_public_inbox_keys
  add column if not exists campaign_id uuid;

-- Inbound messages whose sender is one of the numbers used in a campaign.
-- Numbers are compared digits-only; WhatsApp ids carry the country code while
-- uploaded contacts often do not, so the last 10 digits are accepted too.
create or replace function public.wb_campaign_inbound(
  p_user_id uuid, p_campaign_id uuid, p_limit int default 200
) returns setof public.wb_inbound_messages
language sql stable as $$
  with nums as (
    select distinct d, case when length(d) >= 10 then right(d, 10) end as tail
    from (
      select regexp_replace(coalesce(q.wa_id, ''), '\D', '', 'g') as d
        from public.wb_send_queue q
       where q.campaign_id = p_campaign_id and q.user_id = p_user_id
      union
      select regexp_replace(coalesce(q.phone, ''), '\D', '', 'g')
        from public.wb_send_queue q
       where q.campaign_id = p_campaign_id and q.user_id = p_user_id
    ) s
    where d <> ''
  )
  select m.*
    from public.wb_inbound_messages m
   where m.user_id = p_user_id
     and exists (
       select 1 from nums n
        where n.d = regexp_replace(coalesce(m.phone, ''), '\D', '', 'g')
           or (n.tail is not null
               and n.tail = right(regexp_replace(coalesce(m.phone, ''), '\D', '', 'g'), 10))
     )
   order by m.created_at desc
   limit greatest(least(coalesce(p_limit, 200), 500), 1)
$$;

revoke all on function public.wb_campaign_inbound(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.wb_campaign_inbound(uuid, uuid, int) to service_role;

-- Single-number membership check, used to stop a campaign-scoped link from
-- streaming the voice note of someone who is NOT in that campaign.
create or replace function public.wb_campaign_has_phone(
  p_user_id uuid, p_campaign_id uuid, p_phone text
) returns boolean
language sql stable as $$
  with t as (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d)
  select exists (
    select 1
      from public.wb_send_queue q, t
     where q.campaign_id = p_campaign_id
       and q.user_id = p_user_id
       and t.d <> ''
       and exists (
         select 1
           from (values (regexp_replace(coalesce(q.wa_id, ''), '\D', '', 'g')),
                        (regexp_replace(coalesce(q.phone, ''), '\D', '', 'g'))) v(d)
          where v.d <> ''
            and (v.d = t.d
                 or (length(v.d) >= 10 and length(t.d) >= 10 and right(v.d, 10) = right(t.d, 10)))
       )
  )
$$;

revoke all on function public.wb_campaign_has_phone(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.wb_campaign_has_phone(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Backfill voice-note media ids from the raw webhook audit log
--    (only rows that are audio, have no media_id yet, and whose payload we kept;
--     Meta only keeps media ~30 days so older ones can no longer be played anyway)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.wb_webhook_logs') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'wb_inbound_messages' and column_name = 'media_id') then
    update public.wb_inbound_messages m
       set media_id   = x.media_id,
           media_mime = x.mime,
           is_voice   = x.voice
      from (
        select msg->>'id'                           as wa_id,
               msg->'audio'->>'id'                  as media_id,
               msg->'audio'->>'mime_type'           as mime,
               coalesce((msg->'audio'->>'voice')::boolean, false) as voice
          from public.wb_webhook_logs l,
               jsonb_array_elements(coalesce(l.payload->'entry', '[]'::jsonb)) e,
               jsonb_array_elements(coalesce(e->'changes', '[]'::jsonb)) c,
               jsonb_array_elements(coalesce(c->'value'->'messages', '[]'::jsonb)) msg
         where msg->>'type' = 'audio'
      ) x
     where m.wa_message_id = x.wa_id
       and m.message_type = 'audio'
       and m.media_id is null
       and x.media_id is not null;
  end if;
end $$;
