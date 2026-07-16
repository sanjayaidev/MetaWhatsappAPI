-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM — Migration 002
-- Adds tables referenced by src/routes/flows.js, src/routes/sheet-watchers.js,
-- src/sheet-poller.js, and src/google-auth.js that were never created in
-- 001_complete_crm_schema.sql. Run this AFTER 001.
-- ═══════════════════════════════════════════════════════════════

-- ── OAuth tokens (Google Sheets/Drive/Gmail, Facebook, Instagram) ─────
-- Used by src/google-auth.js (getValidGoogleAccessToken) and
-- src/routes/flows.js (oauth-url / callback / status / disconnect).
CREATE TABLE IF NOT EXISTS wb_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('google', 'facebook', 'instagram')),
  token_type TEXT DEFAULT 'oauth2',
  state TEXT UNIQUE,                 -- transient CSRF/lookup value while the OAuth dance is in flight
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at TIMESTAMPTZ,
  scopes JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',       -- e.g. { email, pages: [...] }
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, service)
);
CREATE INDEX IF NOT EXISTS idx_wb_oauth_tokens_user ON wb_oauth_tokens(user_id, service);

DROP TRIGGER IF EXISTS trg_wb_oauth_tokens_updated_at ON wb_oauth_tokens;
CREATE TRIGGER trg_wb_oauth_tokens_updated_at BEFORE UPDATE ON wb_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Sheet watchers (polling-based sheet automation) ───────────────────
-- Used by src/routes/sheet-watchers.js (CRUD) and src/sheet-poller.js (the tick).
CREATE TABLE IF NOT EXISTS wb_sheet_watchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_name TEXT,
  worksheet TEXT NOT NULL,
  watch_type TEXT NOT NULL CHECK (watch_type IN ('new_row', 'date_reminder')),
  name_column TEXT,
  phone_column TEXT,
  email_column TEXT,
  date_column TEXT,
  offset_days INT DEFAULT 0,
  message_template TEXT,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'email', 'instagram', 'facebook')),
  template_id UUID REFERENCES wb_interactive_templates(id) ON DELETE SET NULL,
  placeholder_mapping JSONB DEFAULT '{}',
  poll_interval_minutes INT NOT NULL DEFAULT 15,
  active BOOLEAN DEFAULT true,
  last_row_count INT DEFAULT 0,
  last_polled_at TIMESTAMPTZ,
  last_error TEXT,
  fired_log JSONB DEFAULT '{}',      -- date_reminder dedupe: { "<rowIndex>": "YYYY-M-D" }
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_sheet_watchers_user ON wb_sheet_watchers(user_id);
CREATE INDEX IF NOT EXISTS idx_wb_sheet_watchers_active ON wb_sheet_watchers(active) WHERE active = true;

DROP TRIGGER IF EXISTS trg_wb_sheet_watchers_updated_at ON wb_sheet_watchers;
CREATE TRIGGER trg_wb_sheet_watchers_updated_at BEFORE UPDATE ON wb_sheet_watchers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Visual flow builder ────────────────────────────────────────────────
-- Used by src/routes/flows.js.
CREATE TABLE IF NOT EXISTS wb_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Flow',
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  trigger_config JSONB DEFAULT '{}',
  nodes JSONB DEFAULT '[]',
  edges JSONB DEFAULT '[]',
  variables JSONB DEFAULT '{}',
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wb_flows_user ON wb_flows(user_id);

DROP TRIGGER IF EXISTS trg_wb_flows_updated_at ON wb_flows;
CREATE TRIGGER trg_wb_flows_updated_at BEFORE UPDATE ON wb_flows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS wb_flow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES wb_flows(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  trigger_data JSONB DEFAULT '{}',
  result JSONB DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wb_flow_executions_flow ON wb_flow_executions(flow_id, started_at DESC);

-- ── RLS ─────────────────────────────────────────────────────────────
-- (server.js talks to Supabase via the service_role key, which bypasses
-- RLS — these policies matter only if these tables are ever queried with
-- an anon/user-scoped key, e.g. directly from the browser.)
ALTER TABLE wb_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_sheet_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_flow_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own oauth tokens" ON wb_oauth_tokens;
CREATE POLICY "Users can manage own oauth tokens" ON wb_oauth_tokens FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own sheet watchers" ON wb_sheet_watchers;
CREATE POLICY "Users can manage own sheet watchers" ON wb_sheet_watchers FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own flows" ON wb_flows;
CREATE POLICY "Users can manage own flows" ON wb_flows FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own flow executions" ON wb_flow_executions;
CREATE POLICY "Users can manage own flow executions" ON wb_flow_executions FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
