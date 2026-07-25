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
-- been updated to pass it keep working; the partial unique index only
-- applies once a value is present, so idempotent upserts from the live
-- endpoint don't create duplicates.

ALTER TABLE smc_automation_logs ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_smc_automation_logs_external_id_unique
  ON smc_automation_logs (platform, trigger_type, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_media_id
  ON smc_automation_logs (media_id);

CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_sender_id
  ON smc_automation_logs (sender_id);
