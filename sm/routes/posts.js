const express = require('express');
const { publishDuePostById } = require('../scheduler');
const { decrypt } = require('../lib/crypto');
const instagram = require('../platforms/instagram');
const facebook = require('../platforms/facebook');
const threads = require('../platforms/threads');

function router(pool) {
  const r = express.Router();

  async function getConnection(platform, userId) {
    const res = await pool.query(
      'SELECT * FROM connections WHERE platform=$1 AND is_connected=true AND user_id=$2 ORDER BY updated_at DESC LIMIT 1',
      [platform, userId]
    );
    return res.rows[0] || null;
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
      const localResult = await pool.query(
        `SELECT id, published_ids FROM posts WHERE user_id=$1 AND published_ids IS NOT NULL AND published_ids != '{}'::jsonb`,
        [userId]
      );
      const trackedByPlatform = {};
      for (const row of localResult.rows) {
        const ids = row.published_ids || {};
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

      const existing = await pool.query(
        `SELECT * FROM posts WHERE user_id=$1 AND published_ids->>$2 = $3`,
        [userId, platform, String(remote_id)]
      );
      if (existing.rows.length) {
        return res.json(existing.rows[0]);
      }

      const title = (caption || '').trim().slice(0, 80) || `${platform.charAt(0).toUpperCase() + platform.slice(1)} post`;
      const publishedIds = { [platform]: remote_id };
      const result = await pool.query(
        `INSERT INTO posts (user_id, title, caption, platforms, scheduled_date, status, published_ids)
         VALUES ($1,$2,$3,$4,$5::timestamptz,'published',$6)
         RETURNING *`,
        [userId, title, caption || '', JSON.stringify([platform]), timestamp || null, JSON.stringify(publishedIds)]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const result = await pool.query('SELECT * FROM posts WHERE user_id = $1 ORDER BY scheduled_date DESC', [userId]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { title, caption, hook, platforms, scheduled_date, media_url, google_drive_file_id } = req.body;
      const result = await pool.query(
        `INSERT INTO posts (user_id, title, caption, hook, platforms, scheduled_date, media_url, google_drive_file_id, status)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8, CASE WHEN $6 IS NULL THEN 'draft' ELSE 'scheduled' END)
         RETURNING *`,
        [userId, title, caption, hook, JSON.stringify(platforms || []), scheduled_date || null, media_url || null, google_drive_file_id || null]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { id } = req.params;
      const { title, caption, hook, platforms, scheduled_date, status, media_url, google_drive_file_id } = req.body;
      const result = await pool.query(
        `UPDATE posts SET title=$1, caption=$2, hook=$3, platforms=$4, scheduled_date=$5::timestamptz,
           status=$6, media_url=$7, google_drive_file_id=$8, updated_at=CURRENT_TIMESTAMP WHERE id=$9 AND user_id=$10 RETURNING *`,
        [title, caption, hook, JSON.stringify(platforms || []), scheduled_date || null, status || 'draft', media_url || null, google_drive_file_id || null, id, userId]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      await pool.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
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
      const check = await pool.query('SELECT 1 FROM posts WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Post not found' });
      }
      await publishDuePostById(pool, req.params.id);
      const result = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
