const express = require('express');

function router(supabase) {
  const r = express.Router();

  // GET /api/comments - Fetch recent comments and DMs from automation_logs
  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const limit = parseInt(req.query.limit) || 50;
      const platform = req.query.platform; // Optional filter by platform

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

      // Support both comments and DMs/messages
      let logsQuery = supabase
        .from('smc_automation_logs')
        .select('id, platform, trigger_type, trigger_text, media_id, sender_id, account_id, automation_id, automation_name, response_type, response_content, reply_location, success, error_message, created_at')
        .in('account_id', accountIds)
        .in('trigger_type', ['comment', 'dm', 'message', 'manual_reply'])
        .order('created_at', { ascending: false })
        .limit(limit);
      if (platform) logsQuery = logsQuery.eq('platform', platform);

      const { data, error } = await logsQuery;
      if (error) throw error;
      res.json(data);
    } catch (err) {
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
        .select('platform, account_id, trigger_type, sender_id')
        .eq('id', logId)
        .maybeSingle();
      if (logErr) throw logErr;

      if (!log) {
        return res.status(404).json({ error: 'Comment/Message not found' });
      }

      const { platform, account_id, trigger_type, sender_id } = log;

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
      const { decrypt } = require('../lib/crypto');
      const token = decrypt(conn.access_token);

      // Reply based on platform and trigger type
      let replyId;
      if (platform === 'facebook') {
        const facebook = require('../platforms/facebook');
        if (trigger_type === 'dm' || trigger_type === 'message') {
          // Reply to DM/message using sendDM with optional reply_to_mid
          replyId = await facebook.sendDM(token, conn.page_id || connAccountId, sender_id, message, reply_to_mid);
        } else {
          // Reply to comment
          replyId = await facebook.replyToComment(token, logId, message);
        }
      } else if (platform === 'instagram') {
        const instagram = require('../platforms/instagram');
        if (trigger_type === 'dm' || trigger_type === 'message') {
          // Reply to DM/message using sendDM with optional reply_to_mid
          replyId = await instagram.sendDM(token, connAccountId || conn.page_id, sender_id, message, conn, reply_to_mid);
        } else {
          // Reply to comment
          replyId = await instagram.replyToComment(token, logId, message, conn);
        }
      } else if (platform === 'threads') {
        const threads = require('../platforms/threads');
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
        replyId = await threads.replyToThread(token, threadsUserId, logId, message);
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
          reply_location: trigger_type === 'dm' || trigger_type === 'message' ? 'message' : 'comment',
          success: true,
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
