const cron = require('node-cron');
const { decrypt } = require('./lib/crypto');
const instagram = require('./platforms/instagram');
const facebook = require('./platforms/facebook');
const threads = require('./platforms/threads');
const linkedin = require('./platforms/linkedin');

// Picks the most-recently-connected account for a platform per user.
async function getConnection(pool, platform, userId) {
  const res = await pool.query(
    'SELECT * FROM connections WHERE platform=$1 AND is_connected=true AND user_id=$2 ORDER BY updated_at DESC LIMIT 1',
    [platform, userId]
  );
  return res.rows[0] || null;
}

async function publishToPlatform(pool, platform, post) {
  const conn = await getConnection(pool, platform, post.user_id);
  if (!conn) throw new Error(`No connected ${platform} account`);
  const token = decrypt(conn.access_token);

  if (platform === 'instagram') {
    return instagram.publishPost(token, conn.account_id, { caption: post.caption, mediaUrl: post.media_url }, conn);
  }
  if (platform === 'facebook') {
    return facebook.publishPost(token, conn.page_id || conn.account_id, { caption: post.caption, mediaUrl: post.media_url });
  }
  if (platform === 'threads') {
    return threads.publishPost(token, conn.account_id, { caption: post.caption, mediaUrl: post.media_url });
  }
  if (platform === 'linkedin') {
    // account_id was stored as the raw LinkedIn member id (userinfo "sub") — build the author URN here.
    return linkedin.publishPost(token, `urn:li:person:${conn.account_id}`, { caption: post.caption });
  }
  throw new Error(`Unknown platform: ${platform}`);
}

async function publishOnePost(pool, post) {
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  const publishedIds = { ...(post.published_ids || {}) };
  const errors = { ...(post.publish_errors || {}) };
  let anySuccess = false;
  let anyFailure = false;

  for (const platform of platforms) {
    // Skip if already successfully published to this platform
    if (publishedIds[platform]) {
      console.log(`Post ${post.id} already published to ${platform}, skipping`);
      continue;
    }
    
    try {
      const id = await publishToPlatform(pool, platform, post);
      publishedIds[platform] = id;
      anySuccess = true;
    } catch (err) {
      // Check if this is a duplicate post error from LinkedIn
      const errorData = err.response?.data;
      const isDuplicateError = errorData && (
        errorData.message?.includes('Duplicate post') || 
        errorData.message?.includes('DUPLICATE_POST') ||
        (errorData.errorDetails?.inputErrors?.some(e => e.code === 'DUPLICATE_POST'))
      );
      
      if (isDuplicateError) {
        // For duplicate errors, extract the existing post ID and treat as success
        const existingPostId = errorData.errorDetails?.inputErrors?.[0]?.description?.match(/urn:li:share:(\d+)/)?.[1];
        if (existingPostId) {
          publishedIds[platform] = `urn:li:share:${existingPostId}`;
          anySuccess = true;
          console.log(`Post ${post.id} detected as duplicate on ${platform}, using existing ID: ${publishedIds[platform]}`);
          continue;
        }
      }
      
      errors[platform] = errorData ? JSON.stringify(errorData) : err.message;
      anyFailure = true;
      console.error(`Publish failed for post ${post.id} on ${platform}:`, errors[platform]);
    }
  }

  // Auto status updater: changes status based on publishing results
  let newStatus;
  if (anySuccess && !anyFailure) {
    newStatus = 'published';
  } else if (anySuccess && anyFailure) {
    newStatus = 'partial';
  } else if (anyFailure) {
    newStatus = 'failed';
  } else {
    // No platforms were attempted (empty platforms array or all skipped)
    newStatus = post.status;
  }

  await pool.query(
    `UPDATE posts SET status=$1, published_ids=$2, publish_errors=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4`,
    [newStatus, JSON.stringify(publishedIds), JSON.stringify(errors), post.id]
  );
  
  console.log(`Post ${post.id} status updated to '${newStatus}'`);
}

async function publishDuePosts(pool) {
  const due = await pool.query(
    `SELECT * FROM posts WHERE status='scheduled' AND scheduled_date <= NOW()::timestamptz`
  );
  for (const post of due.rows) {
    await publishOnePost(pool, post);
  }
}

// Used by the manual "publish now" endpoint — bypasses the scheduled_date/status check.
async function publishDuePostById(pool, id) {
  const result = await pool.query('SELECT * FROM posts WHERE id=$1', [id]);
  const post = result.rows[0];
  if (!post) throw new Error('Post not found');
  await publishOnePost(pool, post);
}

function startScheduler(pool) {
  // Every minute — publishing isn't precise-to-the-second on any of these
  // platforms anyway, so a 1-minute poll interval is plenty.
  cron.schedule('* * * * *', () => {
    publishDuePosts(pool).catch((err) => console.error('Scheduler tick failed:', err.message));
  });
  console.log('⏰ Scheduler started (checks every minute for due posts)');
}

module.exports = { startScheduler, publishDuePosts, publishDuePostById };
