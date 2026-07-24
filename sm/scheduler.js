const cron = require('node-cron');
const { decrypt } = require('./lib/crypto');
const instagram = require('./platforms/instagram');
const facebook = require('./platforms/facebook');
const threads = require('./platforms/threads');
const linkedin = require('./platforms/linkedin');

// Picks the most-recently-connected account for a platform per user.
async function getConnection(supabase, platform, userId) {
  const { data, error } = await supabase
    .from('smc_connections')
    .select('*')
    .eq('platform', platform)
    .eq('is_connected', true)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function publishToPlatform(supabase, platform, post) {
  const conn = await getConnection(supabase, platform, post.user_id);
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

async function publishOnePost(supabase, post) {
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
      const id = await publishToPlatform(supabase, platform, post);
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

  const { error } = await supabase
    .from('smc_posts')
    .update({
      status: newStatus,
      published_ids: publishedIds,
      publish_errors: errors,
      updated_at: new Date().toISOString(),
    })
    .eq('id', post.id);
  if (error) throw error;

  console.log(`Post ${post.id} status updated to '${newStatus}'`);
}

async function publishDuePosts(supabase) {
  const { data: due, error } = await supabase
    .from('smc_posts')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_date', new Date().toISOString());
  if (error) throw error;
  for (const post of due || []) {
    await publishOnePost(supabase, post);
  }
}

// Used by the manual "publish now" endpoint — bypasses the scheduled_date/status check.
async function publishDuePostById(supabase, id) {
  const { data: post, error } = await supabase
    .from('smc_posts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!post) throw new Error('Post not found');
  await publishOnePost(supabase, post);
}

function startScheduler(supabase) {
  // Every minute — publishing isn't precise-to-the-second on any of these
  // platforms anyway, so a 1-minute poll interval is plenty.
  cron.schedule('* * * * *', () => {
    publishDuePosts(supabase).catch((err) => console.error('Scheduler tick failed:', err.message));
  });
  console.log('⏰ Scheduler started (checks every minute for due posts)');
}

module.exports = { startScheduler, publishDuePosts, publishDuePostById };
