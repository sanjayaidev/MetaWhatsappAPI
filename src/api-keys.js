const crypto = require('crypto');
const pool = require('./db');

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
    const result = await pool.query(`
      SELECT 
        k.id, k.user_id, k.name, k.key_prefix,
        k.can_send_messages, k.can_read_messages, k.can_manage_templates,
        k.can_manage_contacts, k.can_manage_campaigns, k.can_manage_accounts,
        k.can_access_analytics,
        k.rate_limit_per_minute, k.rate_limit_per_hour, k.rate_limit_per_day,
        k.scoped_phone_number_id, k.expires_at, k.is_active,
        u.email as user_email
      FROM wb_api_keys k
      JOIN auth.users u ON k.user_id = u.id
      WHERE k.key_hash = $1 AND k.is_active = true
        AND (k.expires_at IS NULL OR k.expires_at > NOW())
    `, [keyHash]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const keyData = result.rows[0];
    
    // Update last_used_at
    await pool.query(`
      UPDATE wb_api_keys SET last_used_at = NOW() WHERE id = $1
    `, [keyData.id]);
    
    return {
      id: keyData.id,
      userId: keyData.user_id,
      email: keyData.user_email,
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
 * Check rate limit for an API key
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
  
  try {
    // Check all three time windows
    const result = await pool.query(`
      SELECT 
        (SELECT COALESCE(SUM(request_count), 0) FROM wb_api_key_usage 
         WHERE api_key_id = $1 AND minute_bucket = $2) as minute_count,
        (SELECT COALESCE(SUM(request_count), 0) FROM wb_api_key_usage 
         WHERE api_key_id = $1 AND hour_bucket = $3) as hour_count,
        (SELECT COALESCE(SUM(request_count), 0) FROM wb_api_key_usage 
         WHERE api_key_id = $1 AND day_bucket = $4) as day_count
    `, [apiKeyId, minuteBucket.toISOString(), hourBucket.toISOString(), dayBucket.toISOString()]);
    
    const counts = result.rows[0];
    
    if (counts.minute_count >= perMinute) {
      return { allowed: false, remaining: 0, resetAt: new Date(minuteBucket.getTime() + 60000), reason: 'minute' };
    }
    if (counts.hour_count >= perHour) {
      return { allowed: false, remaining: 0, resetAt: new Date(hourBucket.getTime() + 3600000), reason: 'hour' };
    }
    if (counts.day_count >= perDay) {
      return { allowed: false, remaining: 0, resetAt: new Date(dayBucket.getTime() + 86400000), reason: 'day' };
    }
    
    // Increment usage counters (upsert)
    await Promise.all([
      pool.query(`
        INSERT INTO wb_api_key_usage (api_key_id, minute_bucket, hour_bucket, day_bucket, request_count)
        VALUES ($1, $2, $3, $4, 1)
        ON CONFLICT (api_key_id, minute_bucket) DO UPDATE SET request_count = wb_api_key_usage.request_count + 1, updated_at = NOW()
      `, [apiKeyId, minuteBucket.toISOString(), hourBucket.toISOString(), dayBucket.toISOString()]),
      
      pool.query(`
        INSERT INTO wb_api_key_usage (api_key_id, minute_bucket, hour_bucket, day_bucket, request_count)
        VALUES ($1, $2, $3, $4, 1)
        ON CONFLICT (api_key_id, hour_bucket) DO UPDATE SET request_count = wb_api_key_usage.request_count + 1, updated_at = NOW()
      `, [apiKeyId, minuteBucket.toISOString(), hourBucket.toISOString(), dayBucket.toISOString()]),
      
      pool.query(`
        INSERT INTO wb_api_key_usage (api_key_id, minute_bucket, hour_bucket, day_bucket, request_count)
        VALUES ($1, $2, $3, $4, 1)
        ON CONFLICT (api_key_id, day_bucket) DO UPDATE SET request_count = wb_api_key_usage.request_count + 1, updated_at = NOW()
      `, [apiKeyId, minuteBucket.toISOString(), hourBucket.toISOString(), dayBucket.toISOString()])
    ]);
    
    const remaining = Math.min(
      perMinute - counts.minute_count - 1,
      perHour - counts.hour_count - 1,
      perDay - counts.day_count - 1
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
  
  const result = await pool.query(`
    INSERT INTO wb_api_keys (
      user_id, name, key_hash, key_prefix,
      can_send_messages, can_read_messages, can_manage_templates,
      can_manage_contacts, can_manage_campaigns, can_manage_accounts,
      can_access_analytics,
      rate_limit_per_minute, rate_limit_per_hour, rate_limit_per_day,
      scoped_phone_number_id, description, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
    )
    RETURNING id, name, key_prefix, created_at
  `, [
    params.userId,
    params.name,
    keyHash,
    keyPrefix,
    params.permissions?.canSendMessages || false,
    params.permissions?.canReadMessages || false,
    params.permissions?.canManageTemplates || false,
    params.permissions?.canManageContacts || false,
    params.permissions?.canManageCampaigns || false,
    params.permissions?.canManageAccounts || false,
    params.permissions?.canAccessAnalytics || false,
    params.rateLimits?.perMinute || 60,
    params.rateLimits?.perHour || 1000,
    params.rateLimits?.perDay || 10000,
    params.scopedPhoneNumberId || null,
    params.description || null,
    params.expiresAt || null
  ]);
  
  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    keyPrefix: result.rows[0].key_prefix,
    apiKey, // Return full key only once
    createdAt: result.rows[0].created_at
  };
}

/**
 * List all API keys for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} List of keys (without actual key values)
 */
async function listApiKeys(userId) {
  const result = await pool.query(`
    SELECT id, name, key_prefix, 
           can_send_messages, can_read_messages, can_manage_templates,
           can_manage_contacts, can_manage_campaigns, can_manage_accounts,
           can_access_analytics,
           rate_limit_per_minute, rate_limit_per_hour, rate_limit_per_day,
           scoped_phone_number_id, last_used_at, expires_at, is_active, created_at
    FROM wb_api_keys
    WHERE user_id = $1
    ORDER BY created_at DESC
  `, [userId]);
  
  return result.rows.map(row => ({
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
  const result = await pool.query(`
    UPDATE wb_api_keys SET is_active = false, updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING id
  `, [keyId, userId]);
  
  return result.rows.length > 0;
}

module.exports = {
  generateApiKey,
  verifyApiKey,
  checkRateLimit,
  createApiKey,
  listApiKeys,
  revokeApiKey
};
