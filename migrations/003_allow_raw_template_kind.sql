-- Migration: Allow 'raw' kind on wb_interactive_templates
-- Run this in your Supabase SQL Editor, after 002_interactive_templates_table.sql
--
-- 'raw' templates are saved directly from the Manual JSON reply tab —
-- the config is { interactive: {...} } (a full Meta interactive object)
-- rather than the field-by-field shape used by button/list/cta_url.

ALTER TABLE wb_interactive_templates DROP CONSTRAINT IF EXISTS wb_interactive_templates_kind_check;

ALTER TABLE wb_interactive_templates
    ADD CONSTRAINT wb_interactive_templates_kind_check
    CHECK (kind IN ('text', 'button', 'list', 'cta_url', 'raw'));
