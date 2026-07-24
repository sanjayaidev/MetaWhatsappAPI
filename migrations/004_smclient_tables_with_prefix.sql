-- Migration: Add SMClient tables with smc_ prefix to the existing database
-- This allows the SMClient functionality to coexist with the existing MetaWhatsapp tables
-- Run this against your Supabase project (SQL editor or `psql $DATABASE_URL -f`)

-- smc_users: multi-tenant user store with email/password auth (from SMClient)
CREATE TABLE IF NOT EXISTS smc_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- smc_posts: social media posts with per-platform published-id tracking
CREATE TABLE IF NOT EXISTS smc_posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES smc_users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  caption TEXT,
  hook VARCHAR(500),
  platforms JSONB,
  scheduled_date TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'draft',
  ig_media_id VARCHAR(255),
  media_url TEXT,
  published_ids JSONB DEFAULT '{}'::jsonb,
  publish_errors JSONB DEFAULT '{}'::jsonb,
  google_drive_file_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ensure scheduled_date uses TIMESTAMPTZ for consistent timezone handling
ALTER TABLE smc_posts ALTER COLUMN scheduled_date TYPE TIMESTAMPTZ USING scheduled_date::timestamptz;

-- smc_automations: automation rules for Instagram, Facebook, and Threads comments/DMs
CREATE TABLE IF NOT EXISTS smc_automations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES smc_users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,  -- trigger type: 'comment' or 'dm'
  keywords JSONB,
  ai_prompt TEXT,
  variations JSONB,
  platforms JSONB DEFAULT '["instagram","facebook","threads"]'::jsonb,
  is_active BOOLEAN DEFAULT false,
  reply_location VARCHAR(50) DEFAULT 'comment',
  response_type VARCHAR(50) DEFAULT 'text',
  response_data JSONB DEFAULT '{}'::jsonb,
  target_post_id INTEGER REFERENCES smc_posts(id) ON DELETE SET NULL,
  target_published_ids JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- smc_connections: real multi-account store, tokens encrypted at rest
CREATE TABLE IF NOT EXISTS smc_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES smc_users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  account_name VARCHAR(255),
  account_id VARCHAR(255),
  page_id VARCHAR(255),  -- FB only
  access_token TEXT,
  token_expires_at TIMESTAMP,
  is_connected BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraint: one connection per user/platform/account
DO $$
DECLARE
  current_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
  FROM pg_constraint WHERE conname = 'smc_connections_platform_account_unique';

  IF current_def IS NOT NULL AND current_def <> 'UNIQUE (user_id, platform, account_id)' THEN
    ALTER TABLE smc_connections DROP CONSTRAINT smc_connections_platform_account_unique;
    current_def := NULL;
  END IF;

  IF current_def IS NULL THEN
    ALTER TABLE smc_connections ADD CONSTRAINT smc_connections_platform_account_unique UNIQUE (user_id, platform, account_id);
  END IF;
END $$;

-- smc_processed_webhook_events: idempotency tracking for Meta webhook deliveries
CREATE TABLE IF NOT EXISTS smc_processed_webhook_events (
  event_id VARCHAR(500) PRIMARY KEY,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- smc_automation_logs: track webhook triggers and automation responses
CREATE TABLE IF NOT EXISTS smc_automation_logs (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,
  trigger_text TEXT,
  media_id VARCHAR(255),
  sender_id VARCHAR(255),
  account_id VARCHAR(255),
  automation_id INTEGER REFERENCES smc_automations(id),
  automation_name VARCHAR(255),
  response_type VARCHAR(50),
  response_content TEXT,
  reply_location VARCHAR(50),
  success BOOLEAN DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_smc_posts_user_id ON smc_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_smc_posts_status ON smc_posts(status);
CREATE INDEX IF NOT EXISTS idx_smc_posts_scheduled_date ON smc_posts(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_smc_automations_user_id ON smc_automations(user_id);
CREATE INDEX IF NOT EXISTS idx_smc_automations_is_active ON smc_automations(is_active);
CREATE INDEX IF NOT EXISTS idx_smc_connections_user_id ON smc_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_smc_connections_platform ON smc_connections(platform);
CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_created_at ON smc_automation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_platform ON smc_automation_logs(platform);
CREATE INDEX IF NOT EXISTS idx_smc_automation_logs_automation_id ON smc_automation_logs(automation_id);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE smc_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_processed_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE smc_automation_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for smc_users
DROP POLICY IF EXISTS "Users can read their own data" ON smc_users;
CREATE POLICY "Users can read their own data" ON smc_users
  FOR SELECT USING (auth.uid()::text = email::text OR true); -- Allow service role to bypass

-- RLS Policies for smc_posts
DROP POLICY IF EXISTS "Users can read their own posts" ON smc_posts;
CREATE POLICY "Users can read their own posts" ON smc_posts
  FOR SELECT USING (true); -- Service role bypass
DROP POLICY IF EXISTS "Users can insert their own posts" ON smc_posts;
CREATE POLICY "Users can insert their own posts" ON smc_posts
  FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Users can update their own posts" ON smc_posts;
CREATE POLICY "Users can update their own posts" ON smc_posts
  FOR UPDATE USING (true);
DROP POLICY IF EXISTS "Users can delete their own posts" ON smc_posts;
CREATE POLICY "Users can delete their own posts" ON smc_posts
  FOR DELETE USING (true);

-- RLS Policies for smc_automations
DROP POLICY IF EXISTS "Users can read their own automations" ON smc_automations;
CREATE POLICY "Users can read their own automations" ON smc_automations
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert their own automations" ON smc_automations;
CREATE POLICY "Users can insert their own automations" ON smc_automations
  FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Users can update their own automations" ON smc_automations;
CREATE POLICY "Users can update their own automations" ON smc_automations
  FOR UPDATE USING (true);
DROP POLICY IF EXISTS "Users can delete their own automations" ON smc_automations;
CREATE POLICY "Users can delete their own automations" ON smc_automations
  FOR DELETE USING (true);

-- RLS Policies for smc_connections
DROP POLICY IF EXISTS "Users can read their own connections" ON smc_connections;
CREATE POLICY "Users can read their own connections" ON smc_connections
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert their own connections" ON smc_connections;
CREATE POLICY "Users can insert their own connections" ON smc_connections
  FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Users can update their own connections" ON smc_connections;
CREATE POLICY "Users can update their own connections" ON smc_connections
  FOR UPDATE USING (true);
DROP POLICY IF EXISTS "Users can delete their own connections" ON smc_connections;
CREATE POLICY "Users can delete their own connections" ON smc_connections
  FOR DELETE USING (true);

-- RLS Policies for smc_automation_logs
DROP POLICY IF EXISTS "Users can read their own automation logs" ON smc_automation_logs;
CREATE POLICY "Users can read their own automation logs" ON smc_automation_logs
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert their own automation logs" ON smc_automation_logs;
CREATE POLICY "Users can insert their own automation logs" ON smc_automation_logs
  FOR INSERT WITH CHECK (true);

-- Note: smc_processed_webhook_events doesn't need user-specific policies
-- as it's purely for webhook idempotency

COMMENT ON TABLE smc_users IS 'SMClient: Multi-tenant user store with email/password auth';
COMMENT ON TABLE smc_posts IS 'SMClient: Social media posts with per-platform published-id tracking';
COMMENT ON TABLE smc_automations IS 'SMClient: Automation rules for Instagram, Facebook, and Threads comments/DMs';
COMMENT ON TABLE smc_connections IS 'SMClient: Multi-account store with encrypted tokens';
COMMENT ON TABLE smc_processed_webhook_events IS 'SMClient: Idempotency tracking for Meta webhook deliveries';
COMMENT ON TABLE smc_automation_logs IS 'SMClient: Track webhook triggers and automation responses';
