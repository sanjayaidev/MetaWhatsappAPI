const express = require('express');
const { publishDuePostById } = require('../scheduler');
const { decrypt } = require('../lib/crypto');
const instagram = require('../platforms/instagram');
const facebook = require('../platforms/facebook');
const threads = require('../platforms/threads');

function router(supabase) {
  const r = express.Router();

  async function getConnection(platform, userId) {
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

  // Pulls recent posts straight from Meta for each connected platform, so the
  // automation builder's "specific post" picker isn't limited to posts that
  // were created/published through this app. Posts made directly in the
  // Instagram/Facebook/Threads apps never get a row in our `posts` table, so
  // without this the picker always came up empty for them.
  r.get('/remote', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const platforms = ['instagram', 'facebook', 'threads'];
      const remote = [];

      await Promise.all(platforms.map(async (platform) => {
        const conn = await getConnection(platform, userId);
        if (!conn) return;
        const token = decrypt(conn.access_token);
        try {
          let items = [];
          if (platform === 'instagram') {
            items = (await instagram.listRecentMedia(token, conn.account_id, null, conn)).map((m) => ({
              platform,
              remote_id: m.id,
              caption: m.caption || '',
              timestamp: m.timestamp,
              permalink: m.permalink,
              thumbnail: m.thumbnail_url || m.media_url,
            }));
          } else if (platform === 'facebook') {
            items = (await facebook.listRecentPosts(token, conn.page_id || conn.account_id)).map((p) => ({
              platform,
              remote_id: p.id,
              caption: p.message || '',
              timestamp: p.created_time,
              permalink: p.permalink_url,
              thumbnail: p.thumbnail || null,
            }));
          } else if (platform === 'threads') {
            items = (await threads.listRecentThreads(token, conn.account_id)).map((t) => ({
              platform,
              remote_id: t.id,
              caption: t.text || '',
              timestamp: t.timestamp,
              permalink: t.permalink,
              thumbnail: null,
            }));
          }
          remote.push(...items);
        } catch (err) {
          console.error(`Failed to fetch recent ${platform} posts:`, err.response?.data || err.message);
          // Don't fail the whole request just because one platform's token is stale —
          // the other platforms' posts (and locally-tracked posts) should still show up.
        }
      }));

      // Mark which of these are already tracked locally (imported previously,
      // or originally published through this app) so the UI doesn't duplicate them.
      const { data: localRows, error: localErr } = await supabase
        .from('smc_posts')
        .select('id, published_ids')
        .eq('user_id', userId)
        .not('published_ids', 'is', null);
      if (localErr) throw localErr;

      const trackedByPlatform = {};
      for (const row of localRows || []) {
        const ids = row.published_ids || {};
        if (!Object.keys(ids).length) continue;
        for (const [platform, id] of Object.entries(ids)) {
          trackedByPlatform[`${platform}:${id}`] = row.id;
        }
      }

      const withTrackingInfo = remote
        .map((item) => ({
          ...item,
          local_post_id: trackedByPlatform[`${item.platform}:${item.remote_id}`] || null,
        }))
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

      res.json(withTrackingInfo);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Turns a remote (not-yet-tracked) post into a real row in `posts` so it can
  // be used as an automation's target_post_id, which is a foreign key into
  // this table. Idempotent — re-importing the same remote post returns the
  // existing row instead of creating a duplicate.
  r.post('/import', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { platform, remote_id, caption, timestamp, permalink } = req.body;
      if (!platform || !remote_id) {
        return res.status(400).json({ error: 'platform and remote_id are required' });
      }

      const { data: existing, error: existingErr } = await supabase
        .from('smc_posts')
        .select('*')
        .eq('user_id', userId)
        .eq(`published_ids->>${platform}`, String(remote_id));
      if (existingErr) throw existingErr;
      if (existing && existing.length) {
        return res.json(existing[0]);
      }

      const title = (caption || '').trim().slice(0, 80) || `${platform.charAt(0).toUpperCase() + platform.slice(1)} post`;
      const publishedIds = { [platform]: remote_id };
      const { data: created, error } = await supabase
        .from('smc_posts')
        .insert({
          user_id: userId,
          title,
          caption: caption || '',
          platforms: [platform],
          scheduled_date: timestamp || null,
          status: 'published',
          published_ids: publishedIds,
        })
        .select()
        .single();
      if (error) throw error;
      res.json(created);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { data, error } = await supabase
        .from('smc_posts')
        .select('*')
        .eq('user_id', userId)
        .order('scheduled_date', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { title, caption, hook, platforms, scheduled_date, media_url, google_drive_file_id } = req.body;
      const { data, error } = await supabase
        .from('smc_posts')
        .insert({
          user_id: userId,
          title,
          caption,
          hook,
          platforms: platforms || [],
          scheduled_date: scheduled_date || null,
          media_url: media_url || null,
          google_drive_file_id: google_drive_file_id || null,
          status: scheduled_date ? 'scheduled' : 'draft',
        })
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { id } = req.params;
      const { title, caption, hook, platforms, scheduled_date, status, media_url, google_drive_file_id } = req.body;
      const { data, error } = await supabase
        .from('smc_posts')
        .update({
          title,
          caption,
          hook,
          platforms: platforms || [],
          scheduled_date: scheduled_date || null,
          status: status || 'draft',
          media_url: media_url || null,
          google_drive_file_id: google_drive_file_id || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { error } = await supabase
        .from('smc_posts')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', userId);
      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual trigger — publish immediately instead of waiting for the cron tick
  r.post('/:id/publish-now', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      // Verify ownership
      const { data: check, error: checkErr } = await supabase
        .from('smc_posts')
        .select('id')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (checkErr) throw checkErr;
      if (!check) {
        return res.status(404).json({ error: 'Post not found' });
      }
      await publishDuePostById(supabase, req.params.id);
      const { data, error } = await supabase
        .from('smc_posts')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
