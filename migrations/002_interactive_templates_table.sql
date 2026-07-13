-- Migration: Create Interactive Message Templates Table
-- Run this in your Supabase SQL Editor
--
-- Stores reusable WhatsApp free-form interactive message templates
-- (buttons, lists, cta_url) that users can pick from and customize when
-- replying inside the 24h session window. These are DIFFERENT from
-- wb_templates, which stores Meta-approved HSM templates used for
-- business-initiated messages outside the session window.

CREATE TABLE IF NOT EXISTS wb_interactive_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('text', 'button', 'list', 'cta_url')),

    -- The template body itself: { body, buttons/sections/displayText+url, header, footer }
    -- Shape depends on `kind` — validated at the application layer before send,
    -- not enforced in SQL, since the shape varies per kind.
    config JSONB NOT NULL,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wb_interactive_templates_user_id ON wb_interactive_templates(user_id);

DROP TRIGGER IF EXISTS update_wb_interactive_templates_updated_at ON wb_interactive_templates;
CREATE TRIGGER update_wb_interactive_templates_updated_at
    BEFORE UPDATE ON wb_interactive_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); -- reuses the function created in 001_api_keys_table.sql

ALTER TABLE wb_interactive_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own interactive templates"
    ON wb_interactive_templates FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own interactive templates"
    ON wb_interactive_templates FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own interactive templates"
    ON wb_interactive_templates FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own interactive templates"
    ON wb_interactive_templates FOR DELETE
    USING (auth.uid() = user_id);

COMMENT ON TABLE wb_interactive_templates IS 'Reusable free-form interactive message templates (buttons/list/cta_url) for session-window replies';
