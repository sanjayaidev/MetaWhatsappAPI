-- Migration: single-row shared-owner-Drive token store.
--
-- Replaces the env-var-only GOOGLE_DRIVE_OWNER_REFRESH_TOKEN (which required
-- a redeploy to rotate) with one DB row, managed manually via the
-- /sm/admin/drive page. Every sm/ user's media upload/stream reads this same
-- row — there is intentionally no user_id column, this is operator-level
-- infrastructure, not a per-user connection.
CREATE TABLE IF NOT EXISTS smc_shared_tokens (
  id SERIAL PRIMARY KEY,
  service VARCHAR(50) UNIQUE NOT NULL,  -- e.g. 'google_drive_owner'
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE smc_shared_tokens ENABLE ROW LEVEL SECURITY;

-- No end-user ever touches this table directly (only the service-role key,
-- via the admin-only /sm/admin/drive routes), so no permissive policies are
-- added here — RLS with zero policies denies all access under the anon/auth
-- keys, which is what we want.

COMMENT ON TABLE smc_shared_tokens IS 'SMClient: single-row shared credential store (currently: owner Google Drive), managed manually via /sm/admin/drive';
