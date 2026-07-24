const axios = require('axios');

// Instagram can be connected two ways:
// 1. Facebook Login for Business → uses graph.facebook.com with a Page ID
// 2. Direct Instagram Login → uses graph.instagram.com with the IG Business Account ID
// The connections table stores page_id for path #1, and no page_id for path #2.
// We route based on which path was used, with a fallback to the other host in case
// the stored data is stale or the token works cross-host.
const FB_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const FB_BASE = `https://graph.facebook.com/${FB_VERSION}`;
const IG_BASE = 'https://graph.instagram.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Determine which host to use based on the connection row, and return both
// for fallback purposes.
function getHosts(conn) {
  // If page_id is set, this connection came from Facebook Login for Business → primary is graph.facebook.com
  // Otherwise it's Direct Instagram Login → primary is graph.instagram.com
  const primary = conn.page_id ? FB_BASE : IG_BASE;
  const fallback = conn.page_id ? IG_BASE : FB_BASE;
  return { primary, fallback };
}

async function get(url, params, token) {
  const res = await axios.get(url, { params: { ...params, access_token: token } });
  return res.data;
}

async function post(url, bodyParams, token) {
  const query = new URLSearchParams({ ...bodyParams, access_token: token }).toString();
  const res = await axios.post(`${url}?${query}`);
  return res.data;
}

// Wrapper that tries primary host first, then falls back to secondary host
// Returns { success: true, data: ... } on success, or { success: false, error: err } if both fail
async function postWithFallback(hosts, path, bodyParams, token) {
  const urls = [`${hosts.primary}${path}`, `${hosts.fallback}${path}`];
  let lastError = null;
  
  for (const url of urls) {
    try {
      const result = await post(url, bodyParams, token);
      return { success: true, data: result };
    } catch (err) {
      lastError = err;
      const responseStatus = err.response?.status;
      const errorCode = err.response?.data?.error?.code;
      // Only try fallback for auth/capability errors (#3, #100, #190, 401, 403)
      // Error 190 = Invalid OAuth access token (may be wrong host/token format)
      // For other errors (bad params, not found, etc.) the host won't help
      if (errorCode !== 3 && errorCode !== 100 && errorCode !== 190 && responseStatus !== 401 && responseStatus !== 403) {
        break;
      }
      console.log(`⚠️  Instagram API call failed on ${url} with error ${errorCode || responseStatus}, trying fallback host...`);
    }
  }
  
  return { success: false, error: lastError };
}

async function getWithFallback(hosts, path, params, token) {
  const urls = [`${hosts.primary}${path}`, `${hosts.fallback}${path}`];
  let lastError = null;
  
  for (const url of urls) {
    try {
      const result = await get(url, params, token);
      return { success: true, data: result };
    } catch (err) {
      lastError = err;
      const responseStatus = err.response?.status;
      const errorCode = err.response?.data?.error?.code;
      if (errorCode !== 3 && errorCode !== 100 && errorCode !== 190 && responseStatus !== 401 && responseStatus !== 403) {
        break;
      }
      console.log(`⚠️  Instagram API call failed on ${url} with error ${errorCode || responseStatus}, trying fallback host...`);
    }
  }
  
  return { success: false, error: lastError };
}

async function publishPost(token, igId, { caption, mediaUrl }, conn) {
  if (!mediaUrl) throw new Error('Instagram requires an image_url — set media_url on the post.');
  const hosts = conn ? getHosts(conn) : { primary: FB_BASE, fallback: IG_BASE };
  
  const createResult = await postWithFallback(hosts, `/${igId}/media`, { image_url: mediaUrl, caption: caption || '' }, token);
  if (!createResult.success) {
    throw createResult.error;
  }
  const creationId = createResult.data.id;

  let statusCode = 'IN_PROGRESS';
  for (let i = 0; i < 5 && statusCode === 'IN_PROGRESS'; i++) {
    await sleep(2000);
    const statusRes = await getWithFallback(hosts, `/${creationId}`, { fields: 'status_code' }, token);
    if (!statusRes.success) {
      throw statusRes.error;
    }
    statusCode = statusRes.data.status_code;
  }

  const publishResult = await postWithFallback(hosts, `/${igId}/media_publish`, { creation_id: creationId }, token);
  if (!publishResult.success) {
    throw publishResult.error;
  }
  return publishResult.data.id;
}

async function replyToComment(token, commentId, message, conn) {
  // IMPORTANT: replying to a comment uses the /{ig-comment-id}/replies edge,
  // NOT /{id}/comments — /comments creates a new top-level comment on a media
  // object. Posting to /comments with a comment id (not a media id) returns
  // Graph error code 100 "Unsupported post request... object does not exist",
  // which is misleading since the comment id is perfectly valid — it's just
  // the wrong edge for that id.
  const hosts = conn ? getHosts(conn) : { primary: FB_BASE, fallback: IG_BASE };
  const result = await postWithFallback(hosts, `/${commentId}/replies`, { message }, token);
  if (!result.success) {
    throw result.error;
  }
  return result.data.id;
}

async function sendDM(token, igId, recipientId, text, conn, replyToMid) {
  const hosts = conn ? getHosts(conn) : { primary: FB_BASE, fallback: IG_BASE };
  
  // Build the message payload - supports both text and attachments
  let messagePayload;
  if (replyToMid) {
    // If replying to a specific message, include reply_to field
    messagePayload = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
      reply_to: { mid: replyToMid }
    };
  } else {
    // Standard DM without reply context
    messagePayload = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text }
    };
  }
  
  const result = await postWithFallback(hosts, `/${igId}/messages`, {
    recipient: JSON.stringify(messagePayload.recipient),
    messaging_type: messagePayload.messaging_type,
    message: JSON.stringify(messagePayload.message),
    reply_to: messagePayload.reply_to ? JSON.stringify(messagePayload.reply_to) : undefined
  }, token);
  
  if (!result.success) {
    throw result.error;
  }
  return result.data.message_id;
}

// Sends a DM privately in response to a specific comment. Per Meta's docs
// (Messenger Platform > Instagram > Private Replies), this goes through the
// SAME /messages endpoint as a normal DM (sendDM above) — the only
// difference is the recipient is addressed by { comment_id } instead of
// { id }. There is no separate /{comment-id}/private_replies edge for
// Instagram; posting there returns a misleading "object does not exist"
// error (code 100) since /replies and /private_replies aren't valid edges
// on a comment object.
async function sendPrivateReply(token, igId, commentId, message, conn) {
  const hosts = conn ? getHosts(conn) : { primary: FB_BASE, fallback: IG_BASE };
  const result = await postWithFallback(hosts, `/${igId}/messages`, {
    recipient: JSON.stringify({ comment_id: commentId }),
    message: JSON.stringify({ text: message }),
  }, token);
  if (!result.success) {
    throw result.error;
  }
  return result.data.message_id;
}

// Recent media already published to this IG business account, straight from
// Meta — used so the automation builder can target posts that were published
// outside this app (e.g. from the native Instagram app) and not just posts
// this app scheduled itself.
async function listRecentMedia(token, igId, limit = 25, conn) {
  const hosts = conn ? getHosts(conn) : { primary: FB_BASE, fallback: IG_BASE };
  const result = await getWithFallback(hosts, `/${igId}/media`, {
    fields: 'id,caption,timestamp,permalink,media_type,media_url,thumbnail_url',
    limit,
  }, token);
  if (!result.success) {
    throw result.error;
  }
  return result.data.data || [];
}

// Kept for parity with the test scripts / manual debugging — the webhook
// flow doesn't need this since it gets the sender id directly from the event.
async function getRecipientFromLatestConversation(token, igId, myUsername, conn) {
  const hosts = conn ? getHosts(conn) : { primary: FB_BASE, fallback: IG_BASE };
  const convosResult = await getWithFallback(hosts, `/${igId}/conversations`, { platform: 'instagram' }, token);
  if (!convosResult.success) {
    throw convosResult.error;
  }
  const convos = convosResult.data;
  const thread = convos.data && convos.data[0];
  if (!thread) return null;
  const threadRes = await getWithFallback(hosts, `/${thread.id}`, { fields: 'participants{id,username}' }, token);
  if (!threadRes.success) {
    throw threadRes.error;
  }
  const participants = threadRes.data.participants?.data || [];
  // Match by username, not id — see mst.js debugging notes: the participants
  // edge can represent your own account under a different id than /me does.
  return participants.find((p) => p.username !== myUsername) || null;
}

module.exports = { publishPost, replyToComment, sendDM, sendPrivateReply, getRecipientFromLatestConversation, listRecentMedia };
