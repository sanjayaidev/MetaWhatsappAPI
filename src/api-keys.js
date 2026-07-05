// src/api-keys.js — Supabase REST API (no pg driver)
// Rewritten to match server.js's approach and avoid the pg/IPv6 connection
// issue on Render: this module used to go through src/db.js (a raw `pg` Pool
// on DATABASE_URL, which resolves to an IPv6-only Supabase host and fails
// with ECONNREFUSED/ENETUNREACH on hosts without outbound IPv6). It now uses
// @supabase/supabase-js exclusively, same as the rest of the app.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // service_role bypasses RLS
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/**
 * Generate a secure API key
 * @returns {object} { apiKey, keyHash, keyPrefix }
 */
function generateApiKey() {
  // Format: sk_live_<random32chars>
  const prefix = 'sk_live_';
  const randomPart = crypto.randomBytes(24).toString('hex');
  const apiKey = `${prefix}${randomPart}`;

  // Hash the key for storage (SHA-256)
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Store first 8 chars after prefix for identification
  const keyPrefix = randomPart.substring(0, 8);

  return { apiKey, keyHash, keyPrefix };
}

/**
 * Verify an API key and return the associated user and permissions
 * @param {string} apiKey - The raw API key
 * @returns {Promise<object|null>} User info and permissions or null if invalid
 */
async function verifyApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith('sk_live_')) {
    return null;
  }

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  try {
    const nowIso = new Date().toISOString();

    const { data: keyData, error } = await supabase
      .from('wb_api_keys')
      .select('*')
      .eq('key_hash', keyHash)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .maybeSingle();

    if (error) {
      console.error('[API Key Verification Error]', error.message);
      return null;
    }
    if (!keyData) {
      return null;
    }

    // Look up the owner's email (best-effort — not critical to auth)
    let userEmail = null;
    try {
      const { data: userData } = await supabase.auth.admin.getUserById(keyData.user_id);
      userEmail = userData?.user?.email || null;
    } catch (e) {
      console.error('[API Key Verification] Could not fetch user email:', e.message);
    }

    // Update last_used_at (fire-and-forget, don't block the request on it)
    supabase
      .from('wb_api_keys')
      .update({ last_used_at: nowIso })
      .eq('id', keyData.id)
      .then(({ error: updateErr }) => {
        if (updateErr) console.error('[API Key] last_used_at update failed:', updateErr.message);
      });

    return {
      id: keyData.id,
      userId: keyData.user_id,
      email: userEmail,
      name: keyData.name,
      keyPrefix: keyData.key_prefix,
      permissions: {
        canSendMessages: keyData.can_send_messages,
        canReadMessages: keyData.can_read_messages,
        canManageTemplates: keyData.can_manage_templates,
        canManageContacts: keyData.can_manage_contacts,
        canManageCampaigns: keyData.can_manage_campaigns,
        canManageAccounts: keyData.can_manage_accounts,
        canAccessAnalytics: keyData.can_access_analytics
      },
      rateLimits: {
        perMinute: keyData.rate_limit_per_minute,
        perHour: keyData.rate_limit_per_hour,
        perDay: keyData.rate_limit_per_day
      },
      scopedPhoneNumberId: keyData.scoped_phone_number_id
    };
  } catch (err) {
    console.error('[API Key Verification Error]', err.message);
    return null;
  }
}

/**
 * Check rate limit for an API key.
 *
 * IMPORTANT: only ever writes ONE row per (api_key_id, minute_bucket). Hour
 * and day counts are computed by summing minute-level rows that fall in that
 * hour/day, rather than maintaining separate hour/day rows — the table has
 * independent unique constraints per bucket type, and since many minutes
 * share the same hour_bucket/day_bucket value, writing a distinct row per
 * granularity is guaranteed to collide (this was the cause of the
 * "duplicate key value violates ... hour_bucket_key" error). Run this once
 * in Supabase SQL editor before using this version:
 *   ALTER TABLE wb_api_key_usage DROP CONSTRAINT IF EXISTS wb_api_key_usage_api_key_id_hour_bucket_key;
 *   ALTER TABLE wb_api_key_usage DROP CONSTRAINT IF EXISTS wb_api_key_usage_api_key_id_day_bucket_key;
 *
 * Also note: this does a read-then-write increment instead of an atomic SQL
 * `ON CONFLICT ... SET count = count + 1`, since that's not directly
 * expressible through the Supabase REST client. Under a burst of many
 * simultaneous requests from the *same* key this can under-count slightly —
 * acceptable for per-customer API rate limiting, not for hard exact limits.
 *
 * @param {string} apiKeyId - The API key ID
 * @param {number} perMinute - Max requests per minute
 * @param {number} perHour - Max requests per hour
 * @param {number} perDay - Max requests per day
 * @returns {Promise<object>} { allowed, remaining, resetAt }
 */
async function checkRateLimit(apiKeyId, perMinute, perHour, perDay) {
  const now = new Date();
  const minuteBucket = new Date(now.setSeconds(0, 0));
  const hourBucket = new Date(now.setMinutes(0, 0, 0));
  const dayBucket = new Date(now.setHours(0, 0, 0, 0));
  const minuteIso = minuteBucket.toISOString();
  const hourStartIso = hourBucket.toISOString();
  const hourEndIso = new Date(hourBucket.getTime() + 3600000).toISOString();
  const dayStartIso = dayBucket.toISOString();
  const dayEndIso = new Date(dayBucket.getTime() + 86400000).toISOString();

  try {
    const sumInRange = async (gteVal, ltVal) => {
      const { data, error } = await supabase
        .from('wb_api_key_usage')
        .select('request_count')
        .eq('api_key_id', apiKeyId)
        .gte('minute_bucket', gteVal)
        .lt('minute_bucket', ltVal);
      if (error) throw error;
      return (data || []).reduce((sum, row) => sum + (row.request_count || 0), 0);
    };

    const getMinuteCount = async () => {
      const { data, error } = await supabase
        .from('wb_api_key_usage')
        .select('request_count')
        .eq('api_key_id', apiKeyId)
        .eq('minute_bucket', minuteIso)
        .maybeSingle();
      if (error) throw error;
      return data?.request_count || 0;
    };

    const [minuteCount, hourCount, dayCount] = await Promise.all([
      getMinuteCount(),
      sumInRange(hourStartIso, hourEndIso),
      sumInRange(dayStartIso, dayEndIso)
    ]);

    if (minuteCount >= perMinute) {
      return { allowed: false, remaining: 0, resetAt: new Date(minuteBucket.getTime() + 60000), reason: 'minute' };
    }
    if (hourCount >= perHour) {
      return { allowed: false, remaining: 0, resetAt: new Date(hourBucket.getTime() + 3600000), reason: 'hour' };
    }
    if (dayCount >= perDay) {
      return { allowed: false, remaining: 0, resetAt: new Date(dayBucket.getTime() + 86400000), reason: 'day' };
    }

    // Increment the single minute-level row (this is the only row we ever write)
    const { error: upsertErr } = await supabase
      .from('wb_api_key_usage')
      .upsert(
        {
          api_key_id: apiKeyId,
          minute_bucket: minuteIso,
          hour_bucket: hourStartIso,
          day_bucket: dayStartIso,
          request_count: minuteCount + 1,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'api_key_id,minute_bucket' }
      );
    if (upsertErr) throw upsertErr;

    const remaining = Math.min(
      perMinute - minuteCount - 1,
      perHour - hourCount - 1,
      perDay - dayCount - 1
    );

    return { allowed: true, remaining, resetAt: new Date(minuteBucket.getTime() + 60000) };
  } catch (err) {
    console.error('[Rate Limit Check Error]', err.message);
    return { allowed: true, remaining: perMinute, resetAt: new Date(Date.now() + 60000) }; // Fail open
  }
}

/**
 * Create a new API key for a user
 * @param {object} params - Key parameters
 * @returns {Promise<object>} Created key with raw API key (only returned once)
 */
async function createApiKey(params) {
  const { apiKey, keyHash, keyPrefix } = generateApiKey();

  const { data, error } = await supabase
    .from('wb_api_keys')
    .insert({
      user_id: params.userId,
      name: params.name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      can_send_messages: params.permissions?.canSendMessages || false,
      can_read_messages: params.permissions?.canReadMessages || false,
      can_manage_templates: params.permissions?.canManageTemplates || false,
      can_manage_contacts: params.permissions?.canManageContacts || false,
      can_manage_campaigns: params.permissions?.canManageCampaigns || false,
      can_manage_accounts: params.permissions?.canManageAccounts || false,
      can_access_analytics: params.permissions?.canAccessAnalytics || false,
      rate_limit_per_minute: params.rateLimits?.perMinute || 60,
      rate_limit_per_hour: params.rateLimits?.perHour || 1000,
      rate_limit_per_day: params.rateLimits?.perDay || 10000,
      scoped_phone_number_id: params.scopedPhoneNumberId || null,
      description: params.description || null,
      expires_at: params.expiresAt || null
    })
    .select('id, name, key_prefix, created_at')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    id: data.id,
    name: data.name,
    keyPrefix: data.key_prefix,
    apiKey, // Return full key only once
    createdAt: data.created_at
  };
}

/**
 * List all API keys for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} List of keys (without actual key values)
 */
async function listApiKeys(userId) {
  const { data, error } = await supabase
    .from('wb_api_keys')
    .select(`
      id, name, key_prefix,
      can_send_messages, can_read_messages, can_manage_templates,
      can_manage_contacts, can_manage_campaigns, can_manage_accounts,
      can_access_analytics,
      rate_limit_per_minute, rate_limit_per_hour, rate_limit_per_day,
      scoped_phone_number_id, last_used_at, expires_at, is_active, created_at
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map(row => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    permissions: {
      canSendMessages: row.can_send_messages,
      canReadMessages: row.can_read_messages,
      canManageTemplates: row.can_manage_templates,
      canManageContacts: row.can_manage_contacts,
      canManageCampaigns: row.can_manage_campaigns,
      canManageAccounts: row.can_manage_accounts,
      canAccessAnalytics: row.can_access_analytics
    },
    rateLimits: {
      perMinute: row.rate_limit_per_minute,
      perHour: row.rate_limit_per_hour,
      perDay: row.rate_limit_per_day
    },
    scopedPhoneNumberId: row.scoped_phone_number_id,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    createdAt: row.created_at
  }));
}

/**
 * Revoke an API key
 * @param {string} keyId - Key ID
 * @param {string} userId - User ID (for ownership verification)
 * @returns {Promise<boolean>} Success status
 */
async function revokeApiKey(keyId, userId) {
  const { data, error } = await supabase
    .from('wb_api_keys')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).length > 0;
}

module.exports = {
  generateApiKey,
  verifyApiKey,
  checkRateLimit,
  createApiKey,
  listApiKeys,
  revokeApiKey
};
