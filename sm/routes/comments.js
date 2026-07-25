const express = require('express');
const { decrypt } = require('../lib/crypto');
const facebook = require('../platforms/facebook');
const instagram = require('../platforms/instagram');
const threads = require('../platforms/threads');

// Shapes a live-fetched item (from facebook/instagram/threads listRecentComments
// or listConversations) into an smc_automation_logs row for upsert.
function toLogRow(platform, triggerType, accountId, item) {
  return {
    platform,
    trigger_type: triggerType,
    trigger_text: item.trigger_text || null,
    media_id: item.media_id || null,
    sender_id: item.sender_id || null,
    account_id: accountId,
    automation_id: null,
    automation_name: null,
    response_type: null,
    response_content: null,
    reply_location: null,
    success: false, // "success" tracks whether OUR automation replied — a live-fetched item hasn't been auto-replied to
    error_message: null,
    external_id: item.external_id,
    created_at: item.created_at || new Date().toISOString(),
  };
}

function router(supabase) {
  const r = express.Router();

  // GET /api/comments - Fetch recent comments and DMs from automation_logs
  // Returns latest message per sender_id for each platform/trigger_type combination
  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const limit = parseInt(req.query.limit) || 50;
      const platform = req.query.platform; // Optional filter by platform
      const triggerType = req.query.trigger_type; // Optional filter by trigger_type (comment, dm, message)

      // Get connections for this user to filter by their accounts
      let connectionsQuery = supabase
        .from('smc_connections')
        .select('account_id, page_id, platform')
        .eq('user_id', userId)
        .eq('is_connected', true);
      if (platform) connectionsQuery = connectionsQuery.eq('platform', platform);

      const { data: connections, error: connErr } = await connectionsQuery;
      if (connErr) throw connErr;
      const accountIds = (connections || []).map(c => c.account_id || c.page_id).filter(Boolean);

      if (accountIds.length === 0) {
        return res.json([]);
      }

      // Build query for latest messages per sender
      // We use a subquery approach: first get distinct sender_ids, then fetch latest for each
      let logsQuery = supabase
        .from('smc_automation_logs')
        .select('id, platform, trigger_type, trigger_text, media_id, sender_id, account_id, automation_id, automation_name, response_type, response_content, reply_location, success, error_message, created_at, external_id')
        .in('account_id', accountIds)
        .in('trigger_type', ['comment', 'dm', 'message', 'manual_reply'])
        .order('created_at', { ascending: false })
        .limit(limit);
      
      if (platform) logsQuery = logsQuery.eq('platform', platform);
      if (triggerType) logsQuery = logsQuery.eq('trigger_type', triggerType);

      const { data, error } = await logsQuery;
      if (error) throw error;
      
      // Dedup so the inbox shows exactly one row per "conversation":
      // - comments: one row per POST (media_id) — the most recent comment
      //   on that post, regardless of which user left it.
      // - dm/message: one row per SENDER — the most recent message from
      //   that user, regardless of which post (if any) it relates to.
      // Grouping comments by sender_id (the old behavior) was wrong: it
      // collapsed different posts down to one row whenever the same user
      // had commented on more than one, and showed a separate row per
      // commenter on the same post instead of just the latest comment.
      const grouped = new Map();
      (data || []).forEach(item => {
        const isDm = item.trigger_type === 'dm' || item.trigger_type === 'message';
        const dedupeId = isDm ? item.sender_id : (item.media_id || item.sender_id);
        if (!dedupeId) return; // nothing to key on, skip
        const key = `${item.platform}-${item.trigger_type}-${dedupeId}`;
        if (!grouped.has(key)) {
          grouped.set(key, item);
        }
      });
      
      // Convert back to array and sort by created_at descending
      const result = Array.from(grouped.values())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/comments/live - Fetch comments and DMs directly from Meta,
  // bypassing automation_logs history. This is what backfills the inbox
  // when webhooks were missed or never configured, and is what the
  // dashboard's Refresh button calls.
  //
  // Per platform this returns:
  //   - comments: the single most recent comment on each recent post/media
  //     (one row per post, never more than one).
  //   - dm: the single most recent message in each conversation (one row
  //     per user who has messaged the account).
  // Threads has no DM API, so it only returns comments (replies).
  //
  // Live results are upserted into smc_automation_logs (keyed on
  // platform + trigger_type + external_id) so they get a local id and can
  // immediately be replied to via POST /:id/reply, and so future GET /
  // calls (which read from the DB, not Meta) see them too.
  r.get('/live', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const platformFilter = req.query.platform; // 'facebook' | 'instagram' | 'threads'
      const postLimit = Math.min(parseInt(req.query.post_limit) || 10, 25);
      const dmLimit = Math.min(parseInt(req.query.dm_limit) || 25, 50);

      let connectionsQuery = supabase
        .from('smc_connections')
        .select('platform, account_id, page_id, access_token')
        .eq('user_id', userId)
        .eq('is_connected', true);
      if (platformFilter) connectionsQuery = connectionsQuery.eq('platform', platformFilter);

      const { data: connections, error: connErr } = await connectionsQuery;
      if (connErr) throw connErr;

      if (!connections || connections.length === 0) {
        return res.json([]);
      }

      const errors = [];
      const rowsToUpsert = []; // { external_id, trigger_type, ... } ready for smc_automation_logs

      await Promise.all(connections.map(async (conn) => {
        const accountId = conn.account_id || conn.page_id;

        const recordError = (scope, err) => {
          const message = err.response?.data?.error?.message || err.message;
          console.error(`⚠️  Live-fetch failed (${conn.platform}/${scope}, account ${accountId}): ${message}`);
          errors.push({ platform: conn.platform, account_id: accountId, scope, message });
        };

        let token;
        try {
          token = decrypt(conn.access_token);
        } catch (err) {
          // A single connection's token failing to decrypt used to abort
          // Promise.all entirely, discarding every other platform's
          // in-flight results — that's what could make a working platform
          // (e.g. Facebook) come back empty too if an unrelated IG/Threads
          // connection had a bad token. Caught here so it only affects
          // this one connection.
          recordError('token', err);
          return;
        }

        if (conn.platform === 'facebook') {
          const pageId = conn.page_id || conn.account_id;
          // Comments and DMs are fetched independently — Promise.allSettled
          // (not Promise.all) so a failure in one (e.g. DMs failing because
          // pages_messaging isn't approved yet) can't also wipe out the
          // other, which Promise.all would do since a single rejection
          // fails the whole combined promise.
          const [commentsRes, convosRes] = await Promise.allSettled([
            facebook.listRecentComments(token, pageId, postLimit),
            facebook.listConversations(token, pageId, dmLimit),
          ]);
          if (commentsRes.status === 'fulfilled') {
            commentsRes.value.forEach(c => rowsToUpsert.push(toLogRow('facebook', 'comment', accountId, c)));
          } else {
            recordError('comments', commentsRes.reason);
          }
          if (convosRes.status === 'fulfilled') {
            convosRes.value.forEach(m => rowsToUpsert.push(toLogRow('facebook', 'dm', accountId, m)));
          } else {
            // Most common failure here: pages_messaging not yet granted/approved.
            recordError('dm', convosRes.reason);
          }
        } else if (conn.platform === 'instagram') {
          const igId = conn.account_id;
          const [commentsRes, convosRes] = await Promise.allSettled([
            instagram.listRecentComments(token, igId, postLimit, conn),
            instagram.listConversations(token, igId, dmLimit, conn),
          ]);
          if (commentsRes.status === 'fulfilled') {
            commentsRes.value.forEach(c => rowsToUpsert.push(toLogRow('instagram', 'comment', accountId, c)));
          } else {
            recordError('comments', commentsRes.reason);
          }
          if (convosRes.status === 'fulfilled') {
            convosRes.value.forEach(m => rowsToUpsert.push(toLogRow('instagram', 'dm', accountId, m)));
          } else {
            // Most common failure here: instagram_manage_messages / pages_messaging not yet granted/approved.
            recordError('dm', convosRes.reason);
          }
        } else if (conn.platform === 'threads') {
          try {
            const comments = await threads.listRecentComments(token, conn.account_id, postLimit);
            comments.forEach(c => rowsToUpsert.push(toLogRow('threads', 'comment', accountId, c)));
            // Threads has no DM/messaging API — intentionally nothing to fetch here.
          } catch (err) {
            recordError('comments', err);
          }
        }
      }));

      let result = [];
      if (rowsToUpsert.length > 0) {
        // Upsert on the unique (platform, trigger_type, external_id) index added in
        // migrations/006_add_external_id_to_automation_logs.sql — reruns of this
        // endpoint update existing rows instead of duplicating them.
        const { data: upserted, error: upsertErr } = await supabase
          .from('smc_automation_logs')
          .upsert(rowsToUpsert, { onConflict: 'platform,trigger_type,external_id' })
          .select('id, platform, trigger_type, trigger_text, media_id, sender_id, account_id, automation_id, automation_name, response_type, response_content, reply_location, success, error_message, created_at, external_id');
        if (upsertErr) throw upsertErr;
        result = (upserted || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      }

      res.json({ data: result, errors });
    } catch (err) {
      console.error('Error live-fetching comments/DMs:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/comments/:id/reply - Reply to a comment or DM
  r.post('/:id/reply', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const logId = req.params.id;
      const { message, reply_to_mid } = req.body;

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'message is required' });
      }

      // Get the original log to find platform, account, and trigger type
      const { data: log, error: logErr } = await supabase
        .from('smc_automation_logs')
        .select('platform, account_id, trigger_type, sender_id, external_id')
        .eq('id', logId)
        .maybeSingle();
      if (logErr) throw logErr;

      if (!log) {
        return res.status(404).json({ error: 'Comment/Message not found' });
      }

      const { platform, account_id, trigger_type, sender_id } = log;
      const isDmTrigger = trigger_type === 'dm' || trigger_type === 'message';
      // Comment replies must target the comment's own Graph id
      // (external_id), not this row's local database id — the two are
      // unrelated. Rows from GET /live and freshly-arriving webhooks carry
      // a real external_id; older rows logged before this column existed
      // don't, and fall back to logId, which will fail against the Graph
      // API for comments (it never worked for those rows regardless).
      const commentTargetId = log.external_id || logId;

      // Get the connection with all necessary fields
      const { data: conn, error: connErr } = await supabase
        .from('smc_connections')
        .select('access_token, page_id, account_id')
        .eq('user_id', userId)
        .or(`account_id.eq.${account_id},page_id.eq.${account_id}`)
        .eq('is_connected', true)
        .maybeSingle();
      if (connErr) throw connErr;

      if (!conn) {
        return res.status(400).json({ error: 'No connected account found for this platform' });
      }

      const connAccountId = conn.account_id; // matches previous `conn_account_id` alias usage below
      const token = decrypt(conn.access_token);

      // Reply based on platform and trigger type
      let replyId;
      if (platform === 'facebook') {
        if (isDmTrigger) {
          // Reply to DM/message using sendDM with optional reply_to_mid
          replyId = await facebook.sendDM(token, conn.page_id || connAccountId, sender_id, message, reply_to_mid);
        } else {
          // Reply to comment — must use the comment's own Graph id
          replyId = await facebook.replyToComment(token, commentTargetId, message);
        }
      } else if (platform === 'instagram') {
        if (isDmTrigger) {
          // Reply to DM/message using sendDM with optional reply_to_mid
          replyId = await instagram.sendDM(token, connAccountId || conn.page_id, sender_id, message, conn, reply_to_mid);
        } else {
          // Reply to comment — must use the comment's own Graph id
          replyId = await instagram.replyToComment(token, commentTargetId, message, conn);
        }
      } else if (platform === 'threads') {
        // For Threads, we need the threads user ID from the connection
        const { data: threadsConn, error: threadsConnErr } = await supabase
          .from('smc_connections')
          .select('account_id')
          .eq('user_id', userId)
          .eq('platform', 'threads')
          .eq('is_connected', true)
          .limit(1)
          .maybeSingle();
        if (threadsConnErr) throw threadsConnErr;
        if (!threadsConn) {
          return res.status(400).json({ error: 'No connected Threads account found' });
        }
        const threadsUserId = threadsConn.account_id;
        // Threads only supports replying to comments (no DMs)
        replyId = await threads.replyToThread(token, threadsUserId, commentTargetId, message);
      } else {
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
      }

      // Log the manual reply
      const { error: insertErr } = await supabase
        .from('smc_automation_logs')
        .insert({
          platform,
          trigger_type: 'manual_reply',
          trigger_text: null,
          media_id: null,
          sender_id: null,
          account_id,
          automation_id: null,
          automation_name: 'Manual Reply',
          response_type: 'text',
          response_content: message,
          reply_location: isDmTrigger ? 'message' : 'comment',
          success: true,
          external_id: replyId || null,
        });
      if (insertErr) throw insertErr;

      res.json({ success: true, reply_id: replyId });
    } catch (err) {
      console.error('Error sending reply:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
