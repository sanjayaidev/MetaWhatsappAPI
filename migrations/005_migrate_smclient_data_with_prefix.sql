-- Migration: Migrate existing SMClient data to prefixed tables (if they exist)
-- This script copies data from unprefixed tables (users, posts, automations, etc.) 
-- to the new smc_ prefixed tables. Only run this if you have existing SMClient data.
-- Run this against your Supabase project (SQL editor or `psql $DATABASE_URL -f`)

-- IMPORTANT: Run this ONLY after 004_smclient_tables_with_prefix.sql has been applied

-- Migrate users (if an unprefixed 'users' table exists)
-- Note: This assumes there's a legacy 'users' table from SMClient without prefix
INSERT INTO smc_users (id, email, password_hash, name, is_active, created_at, updated_at)
SELECT id, email, password_hash, name, is_active, created_at, updated_at
FROM users
WHERE NOT EXISTS (SELECT 1 FROM smc_users WHERE smc_users.email = users.email)
ON CONFLICT (id) DO NOTHING;

-- Reset the sequence for smc_users to continue from max id
SELECT setval('smc_users_id_seq', COALESCE((SELECT MAX(id) FROM smc_users), 1) + 1, false);

-- Migrate posts (if an unprefixed 'posts' table exists)
INSERT INTO smc_posts (id, user_id, title, caption, hook, platforms, scheduled_date, status, ig_media_id, media_url, published_ids, publish_errors, google_drive_file_id, created_at, updated_at)
SELECT p.id, p.user_id, p.title, p.caption, p.hook, p.platforms, p.scheduled_date, p.status, p.ig_media_id, p.media_url, p.published_ids, p.publish_errors, p.google_drive_file_id, p.created_at, p.updated_at
FROM posts p
WHERE NOT EXISTS (SELECT 1 FROM smc_posts WHERE smc_posts.id = p.id)
ON CONFLICT (id) DO NOTHING;

-- Reset the sequence for smc_posts
SELECT setval('smc_posts_id_seq', COALESCE((SELECT MAX(id) FROM smc_posts), 1) + 1, false);

-- Migrate automations (if an unprefixed 'automations' table exists)
INSERT INTO smc_automations (id, user_id, name, type, keywords, ai_prompt, variations, platforms, is_active, reply_location, response_type, response_data, target_post_id, target_published_ids, created_at)
SELECT a.id, a.user_id, a.name, a.type, a.keywords, a.ai_prompt, a.variations, a.platforms, a.is_active, a.reply_location, a.response_type, a.response_data, a.target_post_id, a.target_published_ids, a.created_at
FROM automations a
WHERE NOT EXISTS (SELECT 1 FROM smc_automations WHERE smc_automations.id = a.id)
ON CONFLICT (id) DO NOTHING;

-- Reset the sequence for smc_automations
SELECT setval('smc_automations_id_seq', COALESCE((SELECT MAX(id) FROM smc_automations), 1) + 1, false);

-- Migrate connections (if an unprefixed 'connections' table exists)
INSERT INTO smc_connections (id, user_id, platform, account_name, account_id, page_id, access_token, token_expires_at, is_connected, created_at, updated_at)
SELECT c.id, c.user_id, c.platform, c.account_name, c.account_id, c.page_id, c.access_token, c.token_expires_at, c.is_connected, c.created_at, c.updated_at
FROM connections c
WHERE NOT EXISTS (SELECT 1 FROM smc_connections WHERE smc_connections.id = c.id)
ON CONFLICT (id) DO NOTHING;

-- Reset the sequence for smc_connections
SELECT setval('smc_connections_id_seq', COALESCE((SELECT MAX(id) FROM smc_connections), 1) + 1, false);

-- Migrate processed_webhook_events (if an unprefixed table exists)
INSERT INTO smc_processed_webhook_events (event_id, created_at)
SELECT event_id, created_at
FROM processed_webhook_events
WHERE NOT EXISTS (SELECT 1 FROM smc_processed_webhook_events WHERE smc_processed_webhook_events.event_id = processed_webhook_events.event_id)
ON CONFLICT (event_id) DO NOTHING;

-- Migrate automation_logs (if an unprefixed 'automation_logs' table exists)
INSERT INTO smc_automation_logs (id, platform, trigger_type, trigger_text, media_id, sender_id, account_id, automation_id, automation_name, response_type, response_content, reply_location, success, error_message, created_at)
SELECT l.id, l.platform, l.trigger_type, l.trigger_text, l.media_id, l.sender_id, l.account_id, l.automation_id, l.automation_name, l.response_type, l.response_content, l.reply_location, l.success, l.error_message, l.created_at
FROM automation_logs l
WHERE NOT EXISTS (SELECT 1 FROM smc_automation_logs WHERE smc_automation_logs.id = l.id)
ON CONFLICT (id) DO NOTHING;

-- Reset the sequence for smc_automation_logs
SELECT setval('smc_automation_logs_id_seq', COALESCE((SELECT MAX(id) FROM smc_automation_logs), 1) + 1, false);

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'SMClient data migration completed successfully';
  RAISE NOTICE 'Users migrated: %', (SELECT COUNT(*) FROM smc_users);
  RAISE NOTICE 'Posts migrated: %', (SELECT COUNT(*) FROM smc_posts);
  RAISE NOTICE 'Automations migrated: %', (SELECT COUNT(*) FROM smc_automations);
  RAISE NOTICE 'Connections migrated: %', (SELECT COUNT(*) FROM smc_connections);
  RAISE NOTICE 'Webhook events migrated: %', (SELECT COUNT(*) FROM smc_processed_webhook_events);
  RAISE NOTICE 'Automation logs migrated: %', (SELECT COUNT(*) FROM smc_automation_logs);
END $$;
