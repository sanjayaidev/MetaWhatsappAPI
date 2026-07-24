async function initDB(pool) {
  // --- smc_users: multi-tenant user store with email/password auth ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // --- smc_posts: social media posts with per-platform published-id tracking ---
  await pool.query(`
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
    )
  `);
  await pool.query(`ALTER TABLE smc_posts ALTER COLUMN scheduled_date TYPE TIMESTAMPTZ USING scheduled_date::timestamptz`);

  // --- smc_automations: automation rules for Instagram, Facebook, and Threads comments/DMs ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_automations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES smc_users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
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
    )
  `);

  // --- smc_connections: real multi-account store, tokens encrypted at rest ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES smc_users(id) ON DELETE CASCADE,
      platform VARCHAR(50) NOT NULL,
      account_name VARCHAR(255),
      account_id VARCHAR(255),
      page_id VARCHAR(255),
      access_token TEXT,
      token_expires_at TIMESTAMP,
      is_connected BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Unique constraint: one connection per user/platform/account
  await pool.query(`
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
  `);

  // --- smc_processed_webhook_events: idempotency tracking for Meta webhook deliveries ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smc_processed_webhook_events (
      event_id VARCHAR(500) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // --- smc_automation_logs: track webhook triggers and automation responses ---
  await pool.query(`
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
    )
  `);

  console.log('✅ Database tables initialized');
}

module.exports = { initDB };
