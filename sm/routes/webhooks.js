const express = require('express');
const crypto = require('crypto');
const { decrypt } = require('../lib/crypto');
const { findMatch, pickResponse } = require('../automations/matcher');
const { generateReply } = require('../lib/ai');
const instagram = require('../platforms/instagram');
const facebook = require('../platforms/facebook');
const threads = require('../platforms/threads');

// Platform-specific webhook configuration
const FB_VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN;
const FB_APP_SECRET = process.env.FB_SECRET;
const IG_VERIFY_TOKEN = process.env.IG_WEBHOOK_VERIFY_TOKEN;
const IG_APP_SECRET = process.env.IG_SECRET;
const TH_VERIFY_TOKEN = process.env.TH_WEBHOOK_VERIFY_TOKEN;
const TH_APP_SECRET = process.env.TH_SECRET;

// In-memory debug log for recent webhook events (last 100 events)
const webhookDebugLog = [];
const MAX_DEBUG_LOG_SIZE = 100;

function addToDebugLog(event) {
  event.timestamp = new Date().toISOString();
  webhookDebugLog.push(event);
  if (webhookDebugLog.length > MAX_DEBUG_LOG_SIZE) {
    webhookDebugLog.shift();
  }
}

// Helper to log automation events to database
async function logAutomationEvent(pool, data) {
  try {
    await pool.query(
      `INSERT INTO automation_logs
       (platform, trigger_type, trigger_text, media_id, sender_id, account_id,
        automation_id, automation_name, response_type, response_content, reply_location, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        data.platform,
        data.triggerType,
        data.triggerText || null,
        data.mediaId || null,
        data.senderId || null,
        data.accountId || null,
        data.automationId || null,
        data.automationName || null,
        data.responseType || null,
        data.responseContent || null,
        data.replyLocation || null,
        data.success,
        data.errorMessage || null
      ]
    );
  } catch (err) {
    console.error('Failed to log automation event:', err.message);
  }
}

// Helper to get comment reply variations - picks 3 random variations for comments
function getCommentVariations(variations) {
  if (!variations || variations.length === 0) return [];
  // Shuffle and pick up to 3 variations
  const shuffled = [...variations].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(3, shuffled.length));
}

// Helper to pick response based on trigger type and automation config
async function getResponseForTrigger(automation, triggerType, platform, triggerText) {
  // First check response_data for platform-specific and trigger-specific configuration
  const responseData = automation.response_data || {};

  // For comments: check for comment-specific config first, then fallback to general
  if (triggerType === 'comment') {
    const commentConfig = responseData.comment || responseData.general || responseData;

    // Check AI prompt first
    const aiPrompt = commentConfig.system_prompt || automation.ai_prompt;
    if (aiPrompt) {
      const aiText = await generateReply(aiPrompt);
      if (aiText) return { text: aiText, type: 'ai' };
    }

    // Check for comment variations (up to 3)
    const commentVariations = commentConfig.variations || automation.variations || [];
    if (commentVariations.length > 0) {
      // Pick 3 random variations and select one
      const selectedVariations = getCommentVariations(commentVariations);
      if (selectedVariations.length > 0) {
        const selectedVariation = selectedVariations[Math.floor(Math.random() * selectedVariations.length)];
        return { text: selectedVariation, type: 'variation' };
      }
    }

    // Fallback to any variations
    const allVariations = automation.variations || [];
    if (allVariations.length > 0) {
      const selectedVariation = allVariations[Math.floor(Math.random() * allVariations.length)];
      return { text: selectedVariation, type: 'variation' };
    }

    // Backward-compat: automations saved before comment replies were
    // variation-only may have a single plain "message" with no variations.
    if (commentConfig.type === 'text' && commentConfig.message) {
      return { text: commentConfig.message, type: 'text' };
    }

    // Check for button or media responses
    if (commentConfig.type === 'button' && commentConfig.button_text && commentConfig.button_url) {
      return {
        text: commentConfig.message || commentConfig.button_text,
        type: 'button',
        buttonText: commentConfig.button_text,
        buttonUrl: commentConfig.button_url
      };
    }

    if (commentConfig.type === 'media' && commentConfig.media_url) {
      return {
        text: commentConfig.caption || '',
        type: 'media',
        mediaUrl: commentConfig.media_url
      };
    }
  }

  // For DMs: handle based on support type per platform
  if (triggerType === 'dm') {
    const dmConfig = responseData.dm || responseData[platform] || responseData.general || responseData;

    if (dmConfig.support_type === 'tiered') {
      // Tiered support: escalate based on keywords or conversation history
      const tier = dmConfig.tiers?.find(t =>
        t.keywords?.some(k => (triggerText || '').toLowerCase().includes(k.toLowerCase()))
      );
      if (tier?.response) {
        return { text: tier.response, type: 'tiered_support' };
      }
    } else if (dmConfig.support_type === 'categorized') {
      // Categorized support: route based on issue type
      const category = dmConfig.categories?.find(c =>
        c.keywords?.some(k => (triggerText || '').toLowerCase().includes(k.toLowerCase()))
      );
      if (category?.response) {
        return { text: category.response, type: 'categorized_support' };
      }
    }

    // Check AI prompt for DMs
    const aiPrompt = dmConfig.system_prompt || automation.ai_prompt;
    if (aiPrompt) {
      const aiText = await generateReply(aiPrompt);
      if (aiText) return { text: aiText, type: 'ai' };
    }

    // Check for DM-specific variations (kept only for backward-compat with
    // automations saved before DMs became message-only; the builder no
    // longer writes dm.variations going forward)
    const dmVariations = dmConfig.variations || [];
    if (dmVariations.length > 0) {
      const selectedVariation = dmVariations[Math.floor(Math.random() * dmVariations.length)];
      return { text: selectedVariation, type: 'variation' };
    }

    // DMs are a single message by design -- no variation pool like comments.
    if (dmConfig.type === 'text' && dmConfig.message) {
      return { text: dmConfig.message, type: 'text' };
    }

    // Check for button or media responses for DMs
    if (dmConfig.type === 'button' && dmConfig.button_text && dmConfig.button_url) {
      return {
        text: dmConfig.message || dmConfig.button_text,
        type: 'button',
        buttonText: dmConfig.button_text,
        buttonUrl: dmConfig.button_url
      };
    }

    if (dmConfig.type === 'media' && dmConfig.media_url) {
      return {
        text: dmConfig.caption || '',
        type: 'media',
        mediaUrl: dmConfig.media_url
      };
    }
  }

  return null;
}

function router(pool) {
  const r = express.Router();

  // Raw body needed for signature verification — mounted with express.raw
  // in server.js for these two routes specifically, ahead of express.json().

  function verifySignature(req, secret, header) {
    if (!secret) return true; // allow running without a secret in early dev, but warn
    const sig = req.headers[header];
    if (!sig) {
      console.log(`❌ Signature verification failed: Missing ${header} header`);
      addToDebugLog({ event: 'signature_check_failed', reason: 'missing_header', header });
      return false;
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (err) {
      console.log(`❌ Signature verification failed: ${err.message}`);
      addToDebugLog({ event: 'signature_check_failed', reason: 'error', error: err.message });
      return false;
    }
    if (!isValid) {
      console.log(`❌ Signature verification failed: Signature mismatch`);
      addToDebugLog({ event: 'signature_check_failed', reason: 'mismatch' });
    }
    return isValid;
  }

  async function alreadyProcessed(eventId) {
    if (!eventId) return false;
    const existing = await pool.query('SELECT 1 FROM processed_webhook_events WHERE event_id=$1', [eventId]);
    if (existing.rows.length) return true;
    await pool.query(
      'INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId]
    );
    return false;
  }

  async function getConnection(platform, accountId, extraLookupId = null) {
    // Threads' webhook payload doesn't give us a reliable per-account id to
    // match on (see call site below), so accountId is sometimes omitted —
    // passing a bare `undefined` straight to pg throws "could not determine
    // data type of parameter $2", so branch instead of relying on a fallback value.
    if (accountId === undefined || accountId === null) {
      const res = await pool.query(
        'SELECT * FROM connections WHERE platform=$1 AND is_connected=true ORDER BY updated_at DESC LIMIT 1',
        [platform]
      );
      return res.rows[0] || null;
    }
    
    // Primary lookup by original accountId (handles page_id and account_id)
    let res = await pool.query(
      'SELECT * FROM connections WHERE platform=$1 AND (account_id=$2 OR page_id=$2) AND is_connected=true ORDER BY updated_at DESC LIMIT 1',
      [platform, accountId]
    );
    let connection = res.rows[0] || null;
    
    // Fallback lookup using extraLookupId (for direct IG login scenarios)
    if (!connection && extraLookupId) {
      res = await pool.query(
        'SELECT * FROM connections WHERE platform=$1 AND account_id=$2 AND is_connected=true ORDER BY updated_at DESC LIMIT 1',
        [platform, extraLookupId]
      );
      connection = res.rows[0] || null;
    }
    
    // Final fallback for Instagram: return any connected account if specific lookup fails
    if (!connection && platform === 'instagram') {
      res = await pool.query(
        'SELECT * FROM connections WHERE platform=$1 AND is_connected=true AND (account_id IS NOT NULL OR page_id IS NOT NULL) ORDER BY created_at DESC LIMIT 1',
        [platform]
      );
      connection = res.rows[0] || null;
      
      // Log this fallback for debugging
      if (connection) {
        console.log(`[FALLBACK] Using Instagram connection ${connection.account_id || connection.page_id} as fallback for accountId ${accountId}`);
        addToDebugLog({ 
          platform, 
          event: 'connection_fallback', 
          originalAccountId: accountId, 
          fallbackConnectionId: connection.account_id || connection.page_id,
          extraLookupId 
        });
      }
    }
    
    return connection;
  }

  async function getActiveAutomations() {
    const res = await pool.query(
      `SELECT automations.*, 
              COALESCE(automations.target_published_ids, '{}'::jsonb) AS automation_target_published_ids,
              posts.published_ids AS post_published_ids
       FROM automations
       LEFT JOIN posts ON posts.id = automations.target_post_id
       WHERE automations.is_active = true`
    );
    return res.rows.map(row => ({
      ...row,
      // Ensure JSON fields are parsed properly (PostgreSQL may return them as strings)
      response_data: typeof row.response_data === 'string'
        ? JSON.parse(row.response_data)
        : row.response_data || {},
      variations: typeof row.variations === 'string'
        ? JSON.parse(row.variations)
        : row.variations || [],
      keywords: typeof row.keywords === 'string'
        ? JSON.parse(row.keywords)
        : row.keywords || [],
      platforms: typeof row.platforms === 'string'
        ? JSON.parse(row.platforms)
        : row.platforms || ['instagram', 'facebook', 'threads'],
      // Use the new target_published_ids column from automations table if set,
      // otherwise fall back to deriving from posts.published_ids for legacy support
      target_published_ids: typeof row.automation_target_published_ids === 'string'
        ? JSON.parse(row.automation_target_published_ids)
        : (row.automation_target_published_ids && Object.keys(row.automation_target_published_ids).length > 0)
          ? row.automation_target_published_ids
          : (typeof row.post_published_ids === 'string'
              ? JSON.parse(row.post_published_ids)
              : row.post_published_ids || {})
    }));
  }

  // ===== Facebook Webhook =====
  r.get('/webhooks/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  r.post('/webhooks/facebook', express.raw({ type: 'application/json' }), async (req, res) => {
    // Log raw payload for debugging BEFORE signature check
    const rawBody = req.body.toString('utf8');
    console.log('📥 Facebook webhook received - Raw payload:', rawBody.substring(0, 500));
    addToDebugLog({ 
      platform: 'facebook', 
      event: 'webhook_received', 
      headers: req.headers,
      rawPayload: JSON.parse(rawBody || '{}'),
      bodyLength: rawBody.length
    });
    
    // Signature verification with fallback: try FB_APP_SECRET first, then IG_APP_SECRET
    const secretsToTry = [FB_APP_SECRET, IG_APP_SECRET].filter(Boolean);
    let verified = false;
    let usedSecret = null;
    
    for (const secret of secretsToTry) {
      const secretName = secret === FB_APP_SECRET ? 'FB_APP_SECRET' : 'IG_APP_SECRET';
      console.log(`🔐 Trying ${secretName} for Facebook signature verification`);
      if (verifySignature(req, secret, 'x-hub-signature-256')) {
        verified = true;
        usedSecret = secretName;
        break;
      }
    }
    
    if (!verified) {
      console.log('❌ All Facebook signature verification attempts failed');
      addToDebugLog({ platform: 'facebook', event: 'signature_check_failed', reason: 'all_secrets_failed' });
      return res.sendStatus(403);
    }
    
    console.log(`✅ Facebook signature verified using ${usedSecret}`);
    res.sendStatus(200); // ack immediately; Facebook expects a fast 200

    let payload;
    try { 
      payload = JSON.parse(rawBody); 
    } catch (err) { 
      console.log(`❌ Failed to parse Facebook webhook payload: ${err.message}`);
      addToDebugLog({ platform: 'facebook', event: 'parse_error', error: err.message, rawBody });
      return; 
    }

    const platform = 'facebook';
    if (payload.object === 'user') {
      console.log(`⚠️  Received a Facebook USER-object webhook (changed_fields: ${JSON.stringify(payload.entry?.[0]?.changed_fields)}). This app's webhook subscription is set to the "user" object, which only reports personal-profile changes and never delivers Page comments. Subscribe to the "page" object with the "feed" field instead — see setup notes.`);
      addToDebugLog({ platform, event: 'wrong_webhook_object', reason: 'subscribed_to_user_object_not_page', payload });
      return;
    }
    for (const entry of payload.entry || []) {
      // Unlike Instagram, Facebook Page activity (posts, comments, likes,
      // reactions) all arrives on a single "feed" field, disambiguated by
      // value.item / value.verb — there is no separate "comments" field on
      // the Page object. A payload with changed_fields instead of changes
      // (object: "user") means the app is subscribed to the wrong webhook
      // object — see setup notes.
      for (const change of entry.changes || []) {
        if (change.field !== 'feed') {
          console.log(`⚠️  Skipping Facebook change with field: ${change.field}`);
          addToDebugLog({ platform, event: 'skipped_change', reason: 'field_mismatch', field: change.field });
          continue;
        }
        const value = change.value || {};
        if (value.item !== 'comment' || value.verb !== 'add') {
          console.log(`⚠️  Skipping Facebook feed change - item: ${value.item}, verb: ${value.verb}`);
          addToDebugLog({ platform, event: 'skipped_change', reason: 'not_new_comment', item: value.item, verb: value.verb });
          continue;
        }
        const commentId = value.comment_id;
        const text = value.message;
        const mediaId = value.post_id || entry.id;
        // Extract fromId from the comment data
        const fromId = value.from?.id || null;
        if (await alreadyProcessed(`comment:${commentId}`)) continue;
        await handleTrigger({
          platform,
          triggerType: 'comment',
          text,
          replyTargetId: commentId,
          mediaId,
          accountId: entry.id,
          extraLookupId: fromId
        });
      }
      // DMs arrive under "messaging"
      for (const messaging of entry.messaging || []) {
        if (!messaging.message || messaging.message.is_echo) continue;
        const senderId = messaging.sender?.id;
        const text = messaging.message.text;
        const msgId = messaging.message.mid;
        if (await alreadyProcessed(`dm:${msgId}`)) continue;
        await handleTrigger({
          platform,
          triggerType: 'dm',
          text,
          senderId,
          accountId: entry.id,
          extraLookupId: null
        });
      }
    }

    async function handleTrigger({ platform, triggerType, text, replyTargetId, senderId, accountId, mediaId, extraLookupId = null }) {
      console.log(`🔔 Webhook trigger: ${platform}/${triggerType} - Text: "${text?.substring(0, 50)}${text?.length > 50 ? '...' : ''}"`);

      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text, mediaId });

      if (!match) {
        console.log(`⚠️  No matching automation found for ${platform}/${triggerType}`);
        // Log trigger even if no automation matched
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: null,
          automationName: null,
          responseType: null,
          responseContent: null,
          replyLocation: null,
          success: false,
          errorMessage: 'No matching automation found'
        });
        return;
      }

      console.log(`✅ Automation matched: "${match.name}" (ID: ${match.id})`);

      const conn = await getConnection(platform, accountId, extraLookupId);
      if (!conn) {
        console.error(`No connected ${platform} account to reply with`);
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: null,
          responseContent: null,
          replyLocation: triggerType === 'comment' ? (match.reply_location || 'comment') : 'dm',
          success: false,
          errorMessage: `No connected ${platform} account`
        });
        return;
      }
      const token = decrypt(conn.access_token);

      try {
        if (triggerType === 'comment') {
          // See matching comment in the Instagram handler below: reply_location
          // determines whether we post a public reply, send a private-reply
          // DM, or both — this was previously ignored entirely, so 'dm'/'both'
          // automations never sent anything even though they matched.
          const replyLocation = match.reply_location || 'comment';
          const wantsCommentReply = replyLocation === 'comment' || replyLocation === 'both';
          const wantsDmReply = replyLocation === 'dm' || replyLocation === 'both';

          if (wantsCommentReply) {
            const commentResult = await getResponseForTrigger(match, 'comment', platform, text);
            const commentReply = commentResult?.text;
            if (commentReply) {
              console.log(`📤 Sending ${platform} comment reply on behalf of account ${conn.account_id || conn.page_id}`);
              await facebook.replyToComment(token, replyTargetId, commentReply);
              await logAutomationEvent(pool, {
                platform, triggerType, triggerText: text, mediaId, senderId, accountId,
                automationId: match.id, automationName: match.name,
                responseType: commentResult.type, responseContent: commentReply,
                replyLocation: 'comment', success: true, errorMessage: null
              });
            }
          }

          if (wantsDmReply) {
            const dmResult = await getResponseForTrigger(match, 'dm', platform, text);
            const dmReply = dmResult?.text;
            if (dmReply) {
              console.log(`📤 Sending ${platform} private reply (DM) for comment ${replyTargetId} on behalf of account ${conn.account_id || conn.page_id}`);
              await facebook.sendPrivateReply(token, conn.account_id || conn.page_id, replyTargetId, dmReply);
              await logAutomationEvent(pool, {
                platform, triggerType, triggerText: text, mediaId, senderId, accountId,
                automationId: match.id, automationName: match.name,
                responseType: dmResult.type, responseContent: dmReply,
                replyLocation: 'dm', success: true, errorMessage: null
              });
            }
          }
        } else if (triggerType === 'dm') {
          const responseResult = await getResponseForTrigger(match, triggerType, platform, text);
          const reply = responseResult?.text;
          if (!reply) {
            await logAutomationEvent(pool, {
              platform, triggerType, triggerText: text, mediaId, senderId, accountId,
              automationId: match.id, automationName: match.name,
              responseType: null, responseContent: null, replyLocation: null,
              success: false, errorMessage: 'No response generated'
            });
            return;
          }
          await facebook.sendDM(token, conn.account_id || conn.page_id, senderId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType,
            triggerText: text,
            mediaId: null,
            senderId,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'dm',
            success: true,
            errorMessage: null
          });
        }
      } catch (err) {
        const errorMsg = err.response?.data || err.message;
        console.error(`Auto-reply failed (${platform}/${triggerType}):`, errorMsg);
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: null,
          responseContent: null,
          replyLocation: triggerType === 'comment' ? (match.reply_location || 'comment') : 'dm',
          success: false,
          errorMessage: errorMsg
        });
      }
    }
  });

  // ===== Instagram Webhook =====
  r.get('/webhooks/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  r.post('/webhooks/instagram', express.raw({ type: 'application/json' }), async (req, res) => {
    // Log raw payload for debugging BEFORE signature check
    const rawBody = req.body.toString('utf8');
    console.log('📥 Instagram webhook received - Raw payload:', rawBody.substring(0, 500));
    addToDebugLog({
      platform: 'instagram',
      event: 'webhook_received',
      headers: req.headers,
      rawPayload: JSON.parse(rawBody || '{}'),
      bodyLength: rawBody.length
    });

    // Signature verification with fallback: try IG_SECRET first, then FB_SECRET
    const secretsToTry = [IG_APP_SECRET, FB_APP_SECRET].filter(Boolean);
    let verified = false;
    let usedSecret = null;

    for (const secret of secretsToTry) {
      const secretName = secret === FB_APP_SECRET ? 'FB_APP_SECRET' : 'IG_APP_SECRET';
      console.log(`🔐 Trying ${secretName} for Instagram signature verification`);
      if (verifySignature(req, secret, 'x-hub-signature-256')) {
        verified = true;
        usedSecret = secretName;
        break;
      }
    }

    if (!verified) {
      console.log('❌ All signature verification attempts failed');
      return res.sendStatus(403);
    }

    console.log(`✅ Signature verified using ${usedSecret}`);
    res.sendStatus(200);

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      console.log(`❌ Failed to parse Instagram webhook payload: ${err.message}`);
      addToDebugLog({ platform: 'instagram', event: 'parse_error', error: err.message, rawBody });
      return;
    }

    const platform = 'instagram';
    for (const entry of payload.entry || []) {
      // Comments arrive as "changes" with field "comments"
      for (const change of entry.changes || []) {
        if (change.field !== 'comments') {
          console.log(`⚠️  Skipping Instagram change with field: ${change.field}`);
          addToDebugLog({ platform, event: 'skipped_change', reason: 'field_mismatch', field: change.field });
          continue;
        }
        const value = change.value;
        const commentId = value.id;
        const text = value.text;
        const mediaId = value.media?.id || entry.id;
        // Extract fromId from the comment data (Instagram uses 'from' field)
        const fromId = value.from?.id || null;
        if (await alreadyProcessed(`comment:${commentId}`)) continue;
        await handleTrigger({
          platform,
          triggerType: 'comment',
          text,
          replyTargetId: commentId,
          mediaId,
          accountId: entry.id,
          extraLookupId: fromId
        });
      }
      // DMs arrive under "messaging"
      for (const messaging of entry.messaging || []) {
        if (!messaging.message || messaging.message.is_echo) continue;
        const senderId = messaging.sender?.id;
        const text = messaging.message.text;
        const msgId = messaging.message.mid;
        if (await alreadyProcessed(`dm:${msgId}`)) continue;
        await handleTrigger({
          platform,
          triggerType: 'dm',
          text,
          senderId,
          accountId: entry.id,
          extraLookupId: null
        });
      }
    }

    async function handleTrigger({ platform, triggerType, text, replyTargetId, senderId, accountId, mediaId, extraLookupId = null }) {
      console.log(`🔔 Webhook trigger: ${platform}/${triggerType} - Text: "${text?.substring(0, 50)}${text?.length > 50 ? '...' : ''}"`);
      addToDebugLog({
        platform,
        event: 'trigger_received',
        triggerType,
        text,
        mediaId,
        senderId,
        accountId,
        replyTargetId,
        extraLookupId
      });

      const automations = await getActiveAutomations();
      const match = findMatch(automations, { platform, triggerType, text, mediaId });

      if (!match) {
        console.log(`⚠️  No matching automation found for ${platform}/${triggerType}`);
        addToDebugLog({ platform, event: 'no_automation_match', triggerType, text, mediaId });
        // Log trigger even if no automation matched
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: null,
          automationName: null,
          responseType: null,
          responseContent: null,
          replyLocation: null,
          success: false,
          errorMessage: 'No matching automation found'
        });
        return;
      }

      console.log(`✅ Automation matched: "${match.name}" (ID: ${match.id})`);
      addToDebugLog({ platform, event: 'automation_matched', automationId: match.id, automationName: match.name, triggerType });

      const conn = await getConnection(platform, accountId, extraLookupId);
      if (!conn) {
        console.error(`No connected ${platform} account to reply with`);
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: null,
          responseContent: null,
          replyLocation: triggerType === 'comment' ? (match.reply_location || 'comment') : 'dm',
          success: false,
          errorMessage: `No connected ${platform} account`
        });
        return;
      }
      const token = decrypt(conn.access_token);

      try {
        if (triggerType === 'comment') {
          // reply_location controls whether a comment trigger gets a public
          // comment reply, a private DM reply, or both. Previously this was
          // never checked — every comment trigger only ever got a public
          // reply, even when the automation was configured for 'dm' or
          // 'both'. That's why "reply via DM" automations silently never
          // sent anything: Instagram shows the commenter a pending "..."
          // conversation (expecting a private reply within the response
          // window) that then never resolves, because nothing was ever sent.
          const replyLocation = match.reply_location || 'comment';
          const wantsCommentReply = replyLocation === 'comment' || replyLocation === 'both';
          const wantsDmReply = replyLocation === 'dm' || replyLocation === 'both';

          if (wantsCommentReply) {
            const commentResult = await getResponseForTrigger(match, 'comment', platform, text);
            const commentReply = commentResult?.text;
            if (commentReply) {
              console.log(`📤 Sending ${platform} comment reply on behalf of account ${conn.account_id || conn.page_id}`);
              await instagram.replyToComment(token, replyTargetId, commentReply, conn);
              await logAutomationEvent(pool, {
                platform, triggerType, triggerText: text, mediaId, senderId, accountId,
                automationId: match.id, automationName: match.name,
                responseType: commentResult.type, responseContent: commentReply,
                replyLocation: 'comment', success: true, errorMessage: null
              });
            }
          }

          if (wantsDmReply) {
            const dmResult = await getResponseForTrigger(match, 'dm', platform, text);
            const dmReply = dmResult?.text;
            if (dmReply) {
              console.log(`📤 Sending ${platform} private reply (DM) for comment ${replyTargetId} on behalf of account ${conn.account_id || conn.page_id}`);
              await instagram.sendPrivateReply(token, conn.account_id || conn.page_id, replyTargetId, dmReply, conn);
              await logAutomationEvent(pool, {
                platform, triggerType, triggerText: text, mediaId, senderId, accountId,
                automationId: match.id, automationName: match.name,
                responseType: dmResult.type, responseContent: dmReply,
                replyLocation: 'dm', success: true, errorMessage: null
              });
            }
          }
        } else if (triggerType === 'dm') {
          const responseResult = await getResponseForTrigger(match, triggerType, platform, text);
          const reply = responseResult?.text;
          if (!reply) {
            await logAutomationEvent(pool, {
              platform, triggerType, triggerText: text, mediaId, senderId, accountId,
              automationId: match.id, automationName: match.name,
              responseType: null, responseContent: null, replyLocation: null,
              success: false, errorMessage: 'No response generated'
            });
            return;
          }
          console.log(`📤 Sending ${platform} dm reply on behalf of account ${conn.account_id || conn.page_id}`);
          if (platform === 'instagram') {
            await instagram.sendDM(token, conn.account_id || conn.page_id, senderId, reply, conn);
          } else if (platform === 'facebook') {
            await facebook.sendDM(token, conn.account_id || conn.page_id, senderId, reply);
          }
          // Threads has no DM API
          await logAutomationEvent(pool, {
            platform,
            triggerType,
            triggerText: text,
            mediaId: null,
            senderId,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'dm',
            success: true,
            errorMessage: null
          });
        }
      } catch (err) {
        const errorMsg = err.response?.data || err.message;
        console.error(`Auto-reply failed (${platform}/${triggerType}):`, errorMsg);
        await logAutomationEvent(pool, {
          platform,
          triggerType,
          triggerText: text,
          mediaId,
          senderId,
          accountId,
          automationId: match.id,
          automationName: match.name,
          responseType: null,
          responseContent: null,
          replyLocation: triggerType === 'comment' ? (match.reply_location || 'comment') : 'dm',
          success: false,
          errorMessage: errorMsg
        });
      }
    }
  });

  // ===== Threads Webhook =====
  // NOTE: Threads' webhook payload shape may need adjusting to match what
  // Meta actually sends for your app — verify against real deliveries in
  // the App Dashboard's webhook test tool before relying on this in prod.
  r.get('/webhooks/threads', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === TH_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  r.post('/webhooks/threads', express.raw({ type: 'application/json' }), async (req, res) => {
    // Log raw payload for debugging BEFORE signature check
    const rawBody = req.body.toString('utf8');
    console.log('📥 Threads webhook received - Raw payload:', rawBody.substring(0, 500));
    addToDebugLog({
      platform: 'threads',
      event: 'webhook_received',
      headers: req.headers,
      rawPayload: JSON.parse(rawBody || '{}'),
      bodyLength: rawBody.length
    });

    // Signature verification with fallback: try TH_SECRET first, then IG_SECRET, then FB_SECRET
    const secretsToTry = [TH_APP_SECRET, IG_APP_SECRET, FB_APP_SECRET].filter(Boolean);
    let verified = false;
    let usedSecret = null;

    for (const secret of secretsToTry) {
      const secretName = secret === TH_APP_SECRET ? 'TH_APP_SECRET' : secret === IG_APP_SECRET ? 'IG_APP_SECRET' : 'FB_APP_SECRET';
      console.log(`🔐 Trying ${secretName} for Threads signature verification`);
      if (verifySignature(req, secret, 'x-hub-signature-256')) {
        verified = true;
        usedSecret = secretName;
        break;
      }
    }

    if (!verified) {
      console.log('❌ All Threads signature verification attempts failed');
      addToDebugLog({ platform: 'threads', event: 'signature_check_failed', reason: 'all_secrets_failed' });
      return res.sendStatus(403);
    }

    console.log(`✅ Threads signature verified using ${usedSecret}`);
    res.sendStatus(200);

    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }

    const platform = 'threads';

    // Threads webhooks arrive in one of two shapes depending on topic:
    //  - "moderate" topic (what Threads actually sends for comment/reply
    //    events): { topic, target_id, values: [{ value: {...}, uid? }] }
    //  - Legacy Graph-API-style shape some docs describe:
    //    { entry: [{ id, changes: [{ field, value }] }] }
    // The code previously only handled the legacy shape via `payload.entry`,
    // which is undefined for real Threads payloads — so the loop below ran
    // zero times and every Threads comment was silently dropped before any
    // matching/logging happened. Normalize both into a flat item list.
    const items = [];

    if (Array.isArray(payload.values)) {
      for (const item of payload.values) {
        const value = item.value || {};
        items.push({
          text: value.text,
          replyId: value.id,
          // target_id is the post/thread being replied to; prefer the more
          // specific root_post/replied_to id from the payload when present.
          mediaId: value.root_post?.id || value.replied_to?.id || payload.target_id,
          // has_uid_field indicates whether `uid` is populated; fall back to
          // the root post's owner as the account this event belongs to.
          accountId: item.uid || value.root_post?.owner_id || null
        });
      }
    } else {
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'replies' && change.field !== 'comments') {
            console.log(`⚠️  Skipping Threads change with field: ${change.field}`);
            addToDebugLog({ platform, event: 'skipped_change', reason: 'field_mismatch', field: change.field });
            continue;
          }
          const value = change.value || {};
          items.push({
            text: value.text,
            replyId: value.id,
            mediaId: value.media?.id || entry.id,
            accountId: entry.id
          });
        }
      }
    }

    for (const { text, replyId, mediaId, accountId } of items) {
        if (await alreadyProcessed(`threads_reply:${replyId}`)) continue;

        console.log(`🔔 Webhook trigger: ${platform}/comment - Text: "${text?.substring(0, 50)}${text?.length > 50 ? '...' : ''}"`);
        addToDebugLog({
          platform,
          event: 'webhook_trigger',
          triggerType: 'comment',
          text,
          replyId,
          mediaId,
          accountId
        });

        const automations = await getActiveAutomations();
        const match = findMatch(automations, { platform, triggerType: 'comment', text, mediaId });

        if (!match) {
          console.log(`⚠️  No matching automation found for ${platform}/comment`);
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: null,
            automationName: null,
            responseType: null,
            responseContent: null,
            replyLocation: null,
            success: false,
            errorMessage: 'No matching automation found'
          });
          continue;
        }

        console.log(`✅ Automation matched: "${match.name}" (ID: ${match.id})`);

        const responseResult = await getResponseForTrigger(match, 'comment', platform, text);
        const reply = responseResult?.text;

        if (!reply) {
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: null,
            responseContent: null,
            replyLocation: null,
            success: false,
            errorMessage: 'No response generated'
          });
          continue;
        }

        const conn = await getConnection('threads', accountId, null);
        if (!conn) {
          console.error('No connected Threads account to reply with');
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: false,
            errorMessage: 'No connected Threads account'
          });
          continue;
        }
        const token = decrypt(conn.access_token);
        console.log(`📤 Sending Threads reply to comment ${replyId} on behalf of account ${conn.account_id}`);
        try {
          await threads.replyToThread(token, conn.account_id, replyId, reply);
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: true,
            errorMessage: null
          });
        } catch (err) {
          const errorMsg = err.response?.data || err.message;
          console.error('Threads auto-reply failed:', errorMsg);
          await logAutomationEvent(pool, {
            platform,
            triggerType: 'comment',
            triggerText: text,
            mediaId,
            senderId: null,
            accountId,
            automationId: match.id,
            automationName: match.name,
            responseType: responseResult?.type,
            responseContent: reply,
            replyLocation: 'comment',
            success: false,
            errorMessage: errorMsg
          });
        }
    }
  });

  // ===== External API Access with API Key Authentication =====
  // Allows other platforms/apps to access posts and automations with valid API key
  r.get('/api/public/posts', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    try {
      const result = await pool.query('SELECT id, title, caption, hook, platforms, scheduled_date, status, created_at FROM posts ORDER BY scheduled_date DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/api/public/automations', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    try {
      const result = await pool.query('SELECT id, name, type, keywords, ai_prompt, variations, response_data, is_active, created_at FROM automations WHERE is_active=true');
      res.json(result.rows.map(row => ({
        ...row,
        // Ensure response_data and variations are parsed as JSON if they're strings
        response_data: typeof row.response_data === 'string' ? JSON.parse(row.response_data) : row.response_data || {},
        variations: typeof row.variations === 'string' ? JSON.parse(row.variations) : row.variations || []
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Webhook Debug Log API Endpoint =====
  // Returns recent webhook events for debugging - protected by session auth
  r.get('/api/webhooks/debug-log', async (req, res) => {
    // Check if user is authenticated (simple session check)
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const filteredLog = webhookDebugLog.slice(-limit);
    res.json({ debugLog: filteredLog, totalEvents: webhookDebugLog.length });
  });

  // Clear debug log endpoint
  r.post('/api/webhooks/clear-debug-log', async (req, res) => {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    webhookDebugLog.length = 0; // Clear the array
    res.json({ success: true, message: 'Debug log cleared' });
  });

  return r;
}

module.exports = router;
