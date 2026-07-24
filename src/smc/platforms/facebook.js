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
  
  const res = await post(`${BASE}/${pageId}/messages`, {
    recipient: JSON.stringify(messagePayload.recipient),
    messaging_type: messagePayload.messaging_type,
    message: JSON.stringify(messagePayload.message),
    reply_to: messagePayload.reply_to ? JSON.stringify(messagePayload.reply_to) : undefined
  }, token);
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

module.exports = { publishPost, replyToComment, sendDM, sendPrivateReply, listRecentPosts };