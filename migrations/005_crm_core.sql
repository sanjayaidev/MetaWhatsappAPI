-- Migration: CRM core — unified leads, per-channel conversations, sources,
-- field mappings, automations, meetings, chatbot config, subscriptions.
-- Run this in your Supabase SQL Editor, after 004_auto_reply_template_mode.sql

-- ── Unified lead entity ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  ig_handle TEXT,
  fb_psid TEXT,
  primary_source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','engaged','booked','won','follow_up','cold')),
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

-- ── Channel identities linked to a lead (a lead can have >1 identity) ─
CREATE TABLE IF NOT EXISTS wb_lead_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- whatsapp|instagram|facebook|webform|sheet|web_chat|email
  external_id TEXT NOT NULL,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_wb_lead_sources_lead_id ON wb_lead_sources(lead_id);

-- ── Unified timeline: status changes, notes, meetings, auto-sends ────
CREATE TABLE IF NOT EXISTS wb_lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- status_change|note|meeting_booked|auto_message|manual_message
  payload JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_lead_events_lead_id ON wb_lead_events(lead_id, created_at DESC);

-- ── Per-channel conversation log (WA/IG/FB/Email unified) ────────────
CREATE TABLE IF NOT EXISTS wb_channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES wb_leads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT,
  media_url TEXT,
  status TEXT DEFAULT 'sent', -- sent|queued|failed|received
  meta JSONB DEFAULT '{}',
  external_message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_channel_messages_lead ON wb_channel_messages(lead_id, channel, created_at);

-- ── Connected integrations per user ──────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- google_sheet|web_form|instagram|facebook|smbooking|gmail
  config JSONB NOT NULL DEFAULT '{}', -- tokens encrypted at rest via src/crypto.js before insert
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type)
);

-- ── Public inbound webhook tokens (sheet / form POST targets) ────────
CREATE TABLE IF NOT EXISTS wb_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- webform|sheet
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, channel)
);

-- ── Field mappings (incoming form/sheet field -> lead field / tag) ───
CREATE TABLE IF NOT EXISTS wb_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, -- webform|sheet
  mappings JSONB NOT NULL DEFAULT '[]', -- [{source_field, maps_to, tag}]
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, channel)
);

-- ── First-touch / follow-up automation rules ─────────────────────────
CREATE TABLE IF NOT EXISTS wb_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger_source TEXT NOT NULL DEFAULT 'any', -- any|whatsapp|instagram|facebook|webform|sheet|email
  channel TEXT NOT NULL DEFAULT 'all',        -- all|whatsapp|instagram|facebook|email
  message_body TEXT,
  template_id UUID,
  delay_minutes INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_automations_user ON wb_automations(user_id, active);

-- ── Meetings synced from smbooking ────────────────────────────────────
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

-- ── Subscriptions (multi-provider) ───────────────────────────────────
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

-- ── AI chatbot config (website widget + dashboard assistant) ────────
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

-- ── updated_at triggers (reuses function from 001_api_keys_table.sql) ─
DROP TRIGGER IF EXISTS update_wb_leads_updated_at ON wb_leads;
CREATE TRIGGER update_wb_leads_updated_at BEFORE UPDATE ON wb_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_wb_integrations_updated_at ON wb_integrations;
CREATE TRIGGER update_wb_integrations_updated_at BEFORE UPDATE ON wb_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ────────────────────────────────────────────────────────────
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
CREATE POLICY "Users manage own lead_sources" ON wb_lead_sources FOR ALL
  USING (EXISTS (SELECT 1 FROM wb_leads l WHERE l.id = lead_id AND l.user_id = auth.uid()));
CREATE POLICY "Users manage own lead_events" ON wb_lead_events FOR ALL
  USING (EXISTS (SELECT 1 FROM wb_leads l WHERE l.id = lead_id AND l.user_id = auth.uid()));
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
