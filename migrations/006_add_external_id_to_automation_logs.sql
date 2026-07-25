-- Migration: Add external_id to smc_automation_logs
--
-- smc_automation_logs never stored the actual Meta object id for a comment
-- (comment_id) or message (mid) — only the local SERIAL `id` existed, plus
-- `media_id` (the post/media the comment was on, not the comment itself).
-- That made POST /api/comments/:id/reply pass the wrong id to the Graph API
-- for comment replies (it was sending the local row id as the Graph
-- object id). It also means live-fetched comments/DMs (GET
-- /api/comments/live) have no reliable key to upsert on without creating
-- duplicate rows on every refresh.
--
-- external_id stores the true Meta id: comment_id for comments, mid for
-- DMs/messages. Nullable so existing rows and any code path that hasn't
-- been updated to pass it keep working. This must be a plain (non-partial)
-- unique index, not `WHERE external_id IS NOT NULL`: Postgres only lets
-- ON CONFLICT resolve against a partial index if the INSERT repeats the
-- exact same WHERE predicate, and the Supabase JS client's
-- .upsert(rows, { onConflict: '...' }) has no way to pass one through —
-- it always emits a plain ON CONFLICT (columns) with no WHERE clause.
-- Using a partial index here caused every live-fetch upsert to fail with
-- 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"). A plain unique index still allows unlimited rows with
-- a NULL external_id, since SQL treats NULL <> NULL for uniqueness
-- purposes, so idempotent upserts from the live endpoint still work and
-- rows without an external_id still never collide.

ALTER TABLE smc_automation_logs ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);

-- Drop first (not just IF NOT EXISTS + CREATE) so re-running this file
-- against a database that already has the old, broken partial version of
-- this index (from before this migration was fixed) replaces it instead
-- of silently leaving the broken one in place.
DROP INDEX IF EXISTS idx_smc_automation_logs_external_id_unique;

CREATE UNIQUE INDEX idx_smc_automation_logs_external_id_unique
  ON smc_automation_logs (platform, trigger_type, external_id);

CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_media_id
  ON smc_automation_logs (media_id);

CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_sender_id
  ON smc_automation_logs (sender_id);