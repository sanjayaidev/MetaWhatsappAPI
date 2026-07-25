const axios = require('axios');

const VERSION = process.env.GRAPH_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

async function get(url, params, token) {
  const res = await axios.get(url, { params: { ...params, access_token: token } });
  return res.data;
}
async function post(url, bodyParams, token) {
  const query = new URLSearchParams({ ...bodyParams, access_token: token }).toString();
  const res = await axios.post(`${url}?${query}`);
  return res.data;
}

async function publishPost(token, pageId, { caption, mediaUrl }) {
  if (mediaUrl) {
    const res = await post(`${BASE}/${pageId}/photos`, { url: mediaUrl, caption: caption || '' }, token);
    return res.post_id || res.id;
  }
  const res = await post(`${BASE}/${pageId}/feed`, { message: caption || '' }, token);
  return res.id;
}

// Recent posts already published to this Page, straight from Meta — used so
// the automation builder can target posts made outside this app.
async function listRecentPosts(token, pageId, limit = 25) {
  const res = await get(`${BASE}/${pageId}/posts`, {
    fields: 'id,message,created_time,permalink_url,attachments{media{image,source},type,url}',
    limit,
  }, token);
  return (res.data || []).map(post => {
    // Extract thumbnail from attachments if available
    let thumbnail = null;
    if (post.attachments && post.attachments.data && post.attachments.data.length > 0) {
      const attachment = post.attachments.data[0];
      if (attachment.media?.image) {
        thumbnail = attachment.media.image.src || attachment.media.source;
      } else if (attachment.url) {
        thumbnail = attachment.url;
      }
    }
    return {
      ...post,
      thumbnail,
    };
  });
}

async function replyToComment(token, objectId, message) {
  const res = await post(`${BASE}/${objectId}/comments`, { message }, token);
  return res.id;
}

// Live fetch: the most recent comment on each of the Page's recent posts.
// Meta has no single "all comments across all posts" edge, so this fans out
// per-post (order=reverse_chronological + limit=1 gets the latest comment
// without pulling full history). Returns one entry per post that has at
// least one comment — callers wanting "recent comment per post" get that
// for free, no extra dedup needed.
async function listRecentComments(token, pageId, postLimit = 10) {
  const posts = await get(`${BASE}/${pageId}/posts`, { fields: 'id', limit: postLimit }, token);
  const postIds = (posts.data || []).map(p => p.id);

  const results = await Promise.all(postIds.map(async (postId) => {
    try {
      const res = await get(`${BASE}/${postId}/comments`, {
        fields: 'id,message,from,created_time',
        order: 'reverse_chronological',
        limit: 1,
      }, token);
      const comment = (res.data || [])[0];
      if (!comment) return null;
      return {
        external_id: comment.id,
        media_id: postId,
        sender_id: comment.from?.id || null,
        sender_name: comment.from?.name || null,
        trigger_text: comment.message || '',
        created_at: comment.created_time,
      };
    } catch (err) {
      console.log(`⚠️  Facebook: failed to fetch comments for post ${postId}: ${err.response?.data?.error?.message || err.message}`);
      return null;
    }
  }));

  return results.filter(Boolean);
}

// Live fetch: the most recent message in each Messenger conversation for
// this Page — i.e. one row per user who has DMed the Page, showing only
// their latest message. Requires the pages_messaging permission on the
// Page's access token; without it Meta returns error code 10 / subcode
// 2018108 ("access to messenger endpoints"), which is surfaced as-is so
// the caller can tell the difference from a network/auth failure.
async function listConversations(token, pageId, limit = 25) {
  const res = await get(`${BASE}/${pageId}/conversations`, {
    fields: `participants,updated_time,messages.limit(1){message,from,created_time,id}`,
    limit,
  }, token);

  return (res.data || []).map(convo => {
    const latest = convo.messages?.data?.[0];
    if (!latest) return null;
    // The "other" participant — Page itself is also listed in participants.
    const other = (convo.participants?.data || []).find(p => p.id !== pageId) || convo.participants?.data?.[0];
    return {
      external_id: latest.id,
      sender_id: other?.id || latest.from?.id || null,
      sender_name: other?.name || latest.from?.name || null,
      trigger_text: latest.message || '',
      created_at: latest.created_time || convo.updated_time,
    };
  }).filter(Boolean);
}

async function sendDM(token, pageId, recipientId, text, replyToMid) {
  // Build the message payload - supports both text and attachments
  let messagePayload = {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { text }
  };
  
  // If replying to a specific message, include reply_to field
  if (replyToMid) {
    messagePayload.reply_to = { mid: replyToMid };
  }
  
  const bodyParams = {
    recipient: JSON.stringify(messagePayload.recipient),
    messaging_type: messagePayload.messaging_type,
    message: JSON.stringify(messagePayload.message),
  };
  if (messagePayload.reply_to) {
    bodyParams.reply_to = JSON.stringify(messagePayload.reply_to);
  }

  const res = await post(`${BASE}/${pageId}/messages`, bodyParams, token);
  return res.message_id;
}

// Sends a DM privately in response to a specific comment. Per Meta's docs,
// this goes through the SAME /messages endpoint as a normal DM (sendDM
// above) — addressed by recipient: { comment_id } instead of { id }. There
// is no separate /{comment-id}/private_replies edge; posting there returns
// a misleading "object does not exist" error (code 100).
async function sendPrivateReply(token, pageId, commentId, message) {
  const res = await post(`${BASE}/${pageId}/messages`, {
    recipient: JSON.stringify({ comment_id: commentId }),
    message: JSON.stringify({ text: message }),
  }, token);
  return res.message_id;
}

module.exports = { publishPost, replyToComment, sendDM, sendPrivateReply, listRecentPosts, listRecentComments, listConversations };