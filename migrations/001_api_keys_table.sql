-- Migration: Create API Keys Table with Permissions and Rate Limits
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS wb_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(8) NOT NULL, -- First 8 chars for identification (e.g., sk_live_abc12345)
    
    -- Permissions (scopes)
    can_send_messages BOOLEAN DEFAULT false,
    can_read_messages BOOLEAN DEFAULT false,
    can_manage_templates BOOLEAN DEFAULT false,
    can_manage_contacts BOOLEAN DEFAULT false,
    can_manage_campaigns BOOLEAN DEFAULT false,
    can_manage_accounts BOOLEAN DEFAULT false,
    can_access_analytics BOOLEAN DEFAULT false,
    
    -- Rate Limits
    rate_limit_per_minute INTEGER DEFAULT 60,
    rate_limit_per_hour INTEGER DEFAULT 1000,
    rate_limit_per_day INTEGER DEFAULT 10000,
    
    -- Account Scoping (NULL = all accounts, or specific phone_number_id)
    scoped_phone_number_id VARCHAR(255) DEFAULT NULL,
    
    -- Metadata
    description TEXT,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    is_active BOOLEAN DEFAULT true,
    
    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_wb_api_keys_key_hash ON wb_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_wb_api_keys_user_id ON wb_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_wb_api_keys_active ON wb_api_keys(is_active) WHERE is_active = true;

-- Rate limit tracking table
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

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_wb_api_keys_updated_at ON wb_api_keys;
CREATE TRIGGER update_wb_api_keys_updated_at
    BEFORE UPDATE ON wb_api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_wb_api_key_usage_updated_at ON wb_api_key_usage;
CREATE TRIGGER update_wb_api_key_usage_updated_at
    BEFORE UPDATE ON wb_api_key_usage
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) Policies
ALTER TABLE wb_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wb_api_key_usage ENABLE ROW LEVEL SECURITY;

-- Users can only see their own API keys
CREATE POLICY "Users can view own API keys"
    ON wb_api_keys FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own API keys"
    ON wb_api_keys FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own API keys"
    ON wb_api_keys FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own API keys"
    ON wb_api_keys FOR DELETE
    USING (auth.uid() = user_id);

-- Usage tracking is internal (service_role bypasses RLS)
CREATE POLICY "Service can manage usage tracking"
    ON wb_api_key_usage FOR ALL
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE wb_api_keys IS 'Stores API keys with granular permissions and rate limits for external integrations';
COMMENT ON TABLE wb_api_key_usage IS 'Tracks API key usage for rate limiting';
