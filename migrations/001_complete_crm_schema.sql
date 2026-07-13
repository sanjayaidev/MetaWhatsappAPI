-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM - Complete Database Schema (All Migrations Merged)
-- Run this once in your Supabase SQL Editor to set up all tables
-- ═══════════════════════════════════════════════════════════════

-- Helper function for updated_at triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. API Keys Table with Permissions and Rate Limits
CREATE TABLE IF NOT EXISTS wb_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(8) NOT NULL,
    can_send_messages BOOLEAN DEFAULT false,
    can_read_messages BOOLEAN DEFAULT false,
    can_manage_templates BOOLEAN DEFAULT false,
    can_manage_contacts BOOLEAN DEFAULT false,
    can_manage_campaigns BOOLEAN DEFAULT false,
    can_manage_accounts BOOLEAN DEFAULT false,
    can_access_analytics BOOLEAN DEFAULT false,
    rate_limit_per_minute INTEGER DEFAULT 60,
    rate_limit_per_hour INTEGER DEFAULT 1000,
    rate_limit_per_day INTEGER DEFAULT 10000,
    scoped_phone_number_id VARCHAR(255) DEFAULT NULL,
    description TEXT,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wb_api_keys_key_hash ON wb_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_wb_api_keys_user_id ON wb_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_wb_api_keys_active ON wb_api_keys(is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS wb_api_key_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID NOT NULL REFERENCES wb_api_keys(id) ON DELETE CASCADE,
    minute_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    hour_bucket TIMESTAMP WITH TIME ZONE NOT NULL,
    day_bucket DATE NOT NULL,
    request_count INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(api_key_id, minute_bucket),
    UNIQUE(api_key_id, hour_bucket),
    UNIQUE(api_key_id, day_bucket)
);

DROP TRIGGER IF EXISTS update_wb_api_keys_updated_at ON wb_api_keys;
CREATE TRIGGER update_wb_api_keys_updated_at BEFORE UPDATE ON wb_api_keys FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_wb_api_key_usage_updated_at ON wb_api_key_usage;
CREATE TRIGGER update_wb_api_key_usage_updated_at BEFORE UPDATE ON wb_api_key_usage FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE wb_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_api_key_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own API keys" ON wb_api_keys FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own API keys" ON wb_api_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own API keys" ON wb_api_keys FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own API keys" ON wb_api_keys FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Service can manage usage tracking" ON wb_api_key_usage FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE wb_api_keys IS 'Stores API keys with granular permissions and rate limits for external integrations';
COMMENT ON TABLE wb_api_key_usage IS 'Tracks API key usage for rate limiting';

-- 2. Interactive Message Templates Table
CREATE TABLE IF NOT EXISTS wb_interactive_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('text', 'button', 'list', 'cta_url', 'raw')),
    config JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wb_interactive_templates_user_id ON wb_interactive_templates(user_id);

DROP TRIGGER IF EXISTS update_wb_interactive_templates_updated_at ON wb_interactive_templates;
CREATE TRIGGER update_wb_interactive_templates_updated_at BEFORE UPDATE ON wb_interactive_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE wb_interactive_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own interactive templates" ON wb_interactive_templates FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own interactive templates" ON wb_interactive_templates FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own interactive templates" ON wb_interactive_templates FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own interactive templates" ON wb_interactive_templates FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE wb_interactive_templates IS 'Reusable free-form interactive message templates (buttons/list/cta_url/raw) for session-window replies';

-- 3. Auto-reply mode settings
ALTER TABLE wb_settings ADD COLUMN IF NOT EXISTS auto_reply_mode VARCHAR(20) NOT NULL DEFAULT 'ai' CHECK (auto_reply_mode IN ('ai', 'template'));
ALTER TABLE wb_settings ADD COLUMN IF NOT EXISTS auto_reply_template_id UUID REFERENCES wb_interactive_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN wb_settings.auto_reply_mode IS 'ai = existing AI-generated text reply; template = send a fixed interactive template';
COMMENT ON COLUMN wb_settings.auto_reply_template_id IS 'Which wb_interactive_templates row to send when auto_reply_mode = template';

-- 4. CRM Core Tables
CREATE TABLE IF NOT EXISTS wb_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  ig_handle TEXT,
  fb_psid TEXT,
  primary_source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','engaged','booked','won','follow_up','cold')),
  tags JSONB NOT NULL DEFAULT '[]',
  custom_fields JSONB NOT NULL DEFAULT '{}',
  assigned_to UUID REFERENCES auth.users(id),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_leads_user_id ON wb_leads(user_id);
CREATE INDEX IF NOT EXISTS idx_wb_leads_status ON wb_leads(user_id, status);
CREATE INDEX IF NOT EXISTS idx_wb_leads_source ON wb_leads(user_id, primary_source);

CREATE TABLE IF NOT EXISTS wb_lead_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_wb_lead_sources_lead_id ON wb_lead_sources(lead_id);

CREATE TABLE IF NOT EXISTS wb_lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_lead_events_lead_id ON wb_lead_events(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wb_channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT,
  media_url TEXT,
  status TEXT DEFAULT 'sent',
  meta JSONB DEFAULT '{}',
  external_message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_channel_messages_lead ON wb_channel_messages(lead_id, channel, created_at);

CREATE TABLE IF NOT EXISTS wb_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type)
);

CREATE TABLE IF NOT EXISTS wb_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, channel)
);

CREATE TABLE IF NOT EXISTS wb_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  mappings JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, channel)
);

CREATE TABLE IF NOT EXISTS wb_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger_source TEXT NOT NULL DEFAULT 'any',
  channel TEXT NOT NULL DEFAULT 'all',
  message_body TEXT,
  template_id UUID,
  delay_minutes INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_automations_user ON wb_automations(user_id, active);

CREATE TABLE IF NOT EXISTS wb_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES wb_leads(id) ON DELETE SET NULL,
  external_booking_id TEXT,
  event_name TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  status TEXT DEFAULT 'scheduled',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_meetings_user ON wb_meetings(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_wb_meetings_lead ON wb_meetings(lead_id);

CREATE TABLE IF NOT EXISTS wb_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay','stripe','paypal')),
  provider_subscription_id TEXT,
  status TEXT DEFAULT 'pending',
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_subscriptions_user ON wb_subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS wb_chatbot_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('website_widget','dashboard_assistant')),
  system_prompt TEXT,
  knowledge_urls JSONB DEFAULT '[]',
  bot_token TEXT UNIQUE,
  active BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type)
);

DROP TRIGGER IF EXISTS update_wb_leads_updated_at ON wb_leads;
CREATE TRIGGER update_wb_leads_updated_at BEFORE UPDATE ON wb_leads FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_wb_integrations_updated_at ON wb_integrations;
CREATE TRIGGER update_wb_integrations_updated_at BEFORE UPDATE ON wb_integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE wb_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_chatbot_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own leads" ON wb_leads FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own lead_sources" ON wb_lead_sources FOR ALL USING (EXISTS (SELECT 1 FROM wb_leads l WHERE l.id = lead_id AND l.user_id = auth.uid()));
CREATE POLICY "Users manage own lead_events" ON wb_lead_events FOR ALL USING (EXISTS (SELECT 1 FROM wb_leads l WHERE l.id = lead_id AND l.user_id = auth.uid()));
CREATE POLICY "Users manage own channel_messages" ON wb_channel_messages FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own integrations" ON wb_integrations FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own webhook_endpoints" ON wb_webhook_endpoints FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own field_mappings" ON wb_field_mappings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own automations" ON wb_automations FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own meetings" ON wb_meetings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own subscriptions" ON wb_subscriptions FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own chatbot_config" ON wb_chatbot_config FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE wb_leads IS 'Unified CRM lead entity aggregating all channels';
COMMENT ON TABLE wb_channel_messages IS 'Per-channel conversation log (whatsapp/instagram/facebook/email) tied to a lead';
COMMENT ON TABLE wb_integrations IS 'Connected lead-capture / automation integrations per user (tokens in config JSONB should be encrypted before insert)';
