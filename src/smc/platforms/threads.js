const axios = require('axios');

const VERSION = process.env.THREADS_VERSION || 'v1.0';
const BASE = `https://graph.threads.net/${VERSION}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, bodyParams, token) {
  const query = new URLSearchParams({ ...bodyParams, access_token: token }).toString();
  const res = await axios.post(`${url}?${query}`);
  return res.data;
}

async function publishPost(token, threadsUserId, { caption, mediaUrl }) {
  let create;
  if (mediaUrl) {
    // Determine media type from URL extension or default to IMAGE
    const urlLower = mediaUrl.toLowerCase();
    let mediaType = 'IMAGE';
    let paramKey = 'image_url';
    
    if (urlLower.endsWith('.mp4') || urlLower.endsWith('.mov') || urlLower.endsWith('.avi')) {
      mediaType = 'VIDEO';
      paramKey = 'video_url';
    } else if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg') || urlLower.endsWith('.png') || urlLower.endsWith('.webp')) {
      mediaType = 'IMAGE';
      paramKey = 'image_url';
    }
    
    // Post with media (image or video)
    const bodyParams = { 
      media_type: mediaType,
      text: caption || '' 
    };
    bodyParams[paramKey] = mediaUrl;
    
    create = await post(`${BASE}/${threadsUserId}/threads`, bodyParams, token);
  } else {
    // Text-only post
    create = await post(`${BASE}/${threadsUserId}/threads`, { 
      media_type: 'TEXT', 
      text: caption || '' 
    }, token);
  }
  // Meta's own guidance: wait for container processing before publishing.
  // Video containers may take longer to process
  const processingTime = mediaUrl && mediaUrl.toLowerCase().endsWith('.mp4') ? 60000 : 30000;
  await sleep(processingTime);
  const publish = await post(`${BASE}/${threadsUserId}/threads_publish`, { creation_id: create.id }, token);
  return publish.id;
}

// Recent threads already published by this account, straight from Meta —
// used so the automation builder can target posts made outside this app.
async function listRecentThreads(token, threadsUserId, limit = 25) {
  const res = await axios.get(`${BASE}/${threadsUserId}/threads`, {
    params: { fields: 'id,text,timestamp,permalink,media_type,threads_media{media_type,image_url,video_url}', limit, access_token: token },
  });
  return res.data.data || [];
}

async function replyToThread(token, threadsUserId, replyToId, text) {
  const create = await post(`${BASE}/${threadsUserId}/threads`, {
    media_type: 'TEXT',
    text,
    reply_to_id: replyToId,
  }, token);
  await sleep(30000);
  const publish = await post(`${BASE}/${threadsUserId}/threads_publish`, { creation_id: create.id }, token);
  return publish.id;
}

// Threads has no messaging/DM API as of this writing — intentionally not implemented.
async function sendDM() {
  throw new Error('Threads has no DM/messaging API — this is a platform limitation, not a bug.');
}

module.exports = { publishPost, replyToThread, sendDM, listRecentThreads };
