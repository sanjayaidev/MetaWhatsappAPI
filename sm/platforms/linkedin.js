const axios = require('axios');

// Personal-profile posting via Sign In with LinkedIn (OpenID Connect) +
// Share on LinkedIn. No Company Page / Community Management access needed —
// see routes/connections.js for the OAuth flow that gets us the token below.
const BASE = 'https://api.linkedin.com/v2';

async function publishPost(token, personUrn, { caption }) {
  if (!caption) throw new Error('LinkedIn requires text content — set caption on the post.');

  // Generate a unique idempotency key to prevent duplicate posts
  // LinkedIn checks for duplicates based on content + author + visibility
  // Adding a unique request ID helps avoid false duplicate detection
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const res = await axios.post(
    `${BASE}/ugcPosts`,
    {
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: caption },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'X-Restli-Request-Id': requestId,
      },
    }
  );
  return res.data.id;
}

module.exports = { publishPost };
