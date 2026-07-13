-- Migration: Auto-reply mode (AI vs Template)
-- Run this in your Supabase SQL Editor, after 003_allow_raw_template_kind.sql
--
-- Lets a user choose, per account, whether incoming messages get an
-- AI-generated reply (existing behavior, default) or a fixed interactive
-- template (button/list/cta_url/raw) sent as-is.

ALTER TABLE wb_settings
    ADD COLUMN IF NOT EXISTS auto_reply_mode VARCHAR(20) NOT NULL DEFAULT 'ai'
        CHECK (auto_reply_mode IN ('ai', 'template'));

ALTER TABLE wb_settings
    ADD COLUMN IF NOT EXISTS auto_reply_template_id UUID
        REFERENCES wb_interactive_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN wb_settings.auto_reply_mode IS 'ai = existing AI-generated text reply; template = send a fixed interactive template';
COMMENT ON COLUMN wb_settings.auto_reply_template_id IS 'Which wb_interactive_templates row to send when auto_reply_mode = template';
