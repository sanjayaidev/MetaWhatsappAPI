const apiKeys = require('../api-keys');

/**
 * Middleware to verify API key authentication
 * Works alongside existing JWT verification
 */
const verifyApiKey = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();
  
  // Check for API key in Authorization header or x-api-key header
  if (!token || !token.startsWith('sk_live_')) {
    token = String(req.headers['x-api-key'] || '').trim();
  }
  
  if (!token || !token.startsWith('sk_live_')) {
    return next(); // Not an API key, let JWT middleware handle it
  }
  
  try {
    const keyData = await apiKeys.verifyApiKey(token);
    
    if (!keyData) {
      return res.status(401).json({ error: 'Invalid or expired API key' });
    }
    
    // Attach API key info to request
    req.apiKey = keyData;
    req.user = { id: keyData.userId, email: keyData.email };
    
    // Check rate limits
    const rateCheck = await apiKeys.checkRateLimit(
      keyData.id,
      keyData.rateLimits.perMinute,
      keyData.rateLimits.perHour,
      keyData.rateLimits.perDay
    );
    
    if (!rateCheck.allowed) {
      res.setHeader('X-RateLimit-Limit', keyData.rateLimits[`per${rateCheck.reason.charAt(0).toUpperCase() + rateCheck.reason.slice(1)}`]);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', rateCheck.resetAt.toISOString());
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        reason: `Too many requests per ${rateCheck.reason}`,
        resetAt: rateCheck.resetAt.toISOString()
      });
    }
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', keyData.rateLimits.perMinute);
    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
    res.setHeader('X-RateLimit-Reset', rateCheck.resetAt.toISOString());
    
    next();
  } catch (err) {
    console.error('[API Key Middleware Error]', err.message);
    return res.status(500).json({ error: 'Authentication verification failed' });
  }
};

/**
 * Middleware to check specific permissions
 * @param {string} permission - Permission name (e.g., 'canSendMessages')
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.apiKey) {
      return next(); // JWT user, skip API key permission check
    }
    
    if (!req.apiKey.permissions[permission]) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        message: `This API key does not have '${permission}' permission`,
        requiredPermission: permission
      });
    }
    
    next();
  };
};

/**
 * Middleware to check account scoping
 * Ensures API key can only access scoped phone number
 */
const requireScopedAccount = () => {
  return (req, res, next) => {
    if (!req.apiKey || !req.apiKey.scopedPhoneNumberId) {
      return next(); // No scope restriction
    }
    
    const requestedPhoneId = req.body?.phone_number_id || req.params?.phone_number_id || req.query?.phone_number_id;
    
    if (requestedPhoneId && requestedPhoneId !== req.apiKey.scopedPhoneNumberId) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: `This API key is scoped to phone number ${req.apiKey.scopedPhoneNumberId}`
      });
    }
    
    // Inject scoped phone number if not provided
    if (!requestedPhoneId) {
      req.body.phone_number_id = req.apiKey.scopedPhoneNumberId;
    }
    
    next();
  };
};

module.exports = {
  verifyApiKey,
  requirePermission,
  requireScopedAccount
};
