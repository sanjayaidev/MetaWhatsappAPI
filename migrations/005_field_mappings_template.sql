-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM — Migration 005
-- Adds template_id and placeholder_mapping columns to wb_field_mappings
-- for storing auto-reply template configuration per channel.
-- Run this AFTER 001.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE wb_field_mappings
ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES wb_interactive_templates(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS placeholder_mapping JSONB DEFAULT '{}';

COMMENT ON COLUMN wb_field_mappings.template_id IS 'Approved WhatsApp template ID for auto-reply on new leads from this channel';
COMMENT ON COLUMN wb_field_mappings.placeholder_mapping IS 'Mapping of template placeholders to field mappings for auto-reply';
