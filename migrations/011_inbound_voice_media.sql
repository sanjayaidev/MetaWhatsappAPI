-- 011_inbound_voice_media.sql
-- Keeps Meta's media reference for inbound voice notes / audio so they can be
-- streamed on demand to the dashboard Received tab and the public inbox.
-- The public view (wb_public_inbox) does NOT need to change.

alter table public.wb_inbound_messages
  add column if not exists media_id   text,
  add column if not exists media_mime text,
  add column if not exists is_voice   boolean default false;

create index if not exists idx_wb_inbound_messages_media
  on public.wb_inbound_messages (id)
  where media_id is not null;
