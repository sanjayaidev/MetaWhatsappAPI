const express = require('express');

function router(pool) {
  const r = express.Router();

  // GET /api/comments - Fetch recent comments and DMs from automation_logs
  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const limit = parseInt(req.query.limit) || 50;
      const platform = req.query.platform; // Optional filter by platform
      
      // Get connections for this user to filter by their accounts
      let connectionsQuery = 'SELECT account_id, page_id, platform FROM connections WHERE user_id = $1 AND is_connected = true';
      const queryParams = [userId];
      
      if (platform) {
        connectionsQuery += ' AND platform = $2';
        queryParams.push(platform);
      }
      
      const connectionsRes = await pool.query(connectionsQuery, queryParams);
      const accountIds = connectionsRes.rows.map(c => c.account_id || c.page_id);
      
      if (accountIds.length === 0) {
        return res.json([]);
      }
      
      // Support both comments and DMs/messages
      let query = `
        SELECT id, platform, trigger_type, trigger_text, media_id, sender_id, account_id, 
               automation_id, automation_name, response_type, response_content, reply_location, 
               success, error_message, created_at
        FROM automation_logs
        WHERE account_id = ANY($1) AND (trigger_type = 'comment' OR trigger_type = 'dm' OR trigger_type = 'message' OR trigger_type = 'manual_reply')
      `;
      
      if (platform) {
        query += ' AND platform = $2';
      }
      
      query += ' ORDER BY created_at DESC LIMIT $' + (platform ? 3 : 2);
      
      const result = await pool.query(query, platform ? [accountIds, platform, limit] : [accountIds, limit]);
      res.json(result.rows);
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
      const logRes = await pool.query(
        'SELECT platform, account_id, trigger_type, sender_id FROM automation_logs WHERE id = $1',
        [logId]
      );
      
      if (logRes.rows.length === 0) {
        return res.status(404).json({ error: 'Comment/Message not found' });
      }
      
      const { platform, account_id, trigger_type, sender_id } = logRes.rows[0];
      
      // Get the connection with all necessary fields
      const connRes = await pool.query(
        'SELECT access_token, page_id, account_id as conn_account_id FROM connections WHERE user_id = $1 AND (account_id = $2 OR page_id = $2) AND is_connected = true',
        [userId, account_id]
      );
      
      if (connRes.rows.length === 0) {
        return res.status(400).json({ error: 'No connected account found for this platform' });
      }
      
      const conn = connRes.rows[0];
      const { decrypt } = require('../lib/crypto');
      const token = decrypt(conn.access_token);
      
      // Reply based on platform and trigger type
      let replyId;
      if (platform === 'facebook') {
        const facebook = require('../platforms/facebook');
        if (trigger_type === 'dm' || trigger_type === 'message') {
          // Reply to DM/message using sendDM with optional reply_to_mid
          replyId = await facebook.sendDM(token, conn.page_id || conn.conn_account_id, sender_id, message, reply_to_mid);
        } else {
          // Reply to comment
          replyId = await facebook.replyToComment(token, logId, message);
        }
      } else if (platform === 'instagram') {
        const instagram = require('../platforms/instagram');
        if (trigger_type === 'dm' || trigger_type === 'message') {
          // Reply to DM/message using sendDM with optional reply_to_mid
          replyId = await instagram.sendDM(token, conn.conn_account_id || conn.page_id, sender_id, message, conn, reply_to_mid);
        } else {
          // Reply to comment
          replyId = await instagram.replyToComment(token, logId, message, conn);
        }
      } else if (platform === 'threads') {
        const threads = require('../platforms/threads');
        // For Threads, we need the threads user ID from the connection
        const connDetailsRes = await pool.query(
          'SELECT account_id FROM connections WHERE user_id = $1 AND platform = \'threads\' AND is_connected = true LIMIT 1',
          [userId]
        );
        if (connDetailsRes.rows.length === 0) {
          return res.status(400).json({ error: 'No connected Threads account found' });
        }
        const threadsUserId = connDetailsRes.rows[0].account_id;
        // Threads only supports replying to comments (no DMs)
        replyId = await threads.replyToThread(token, threadsUserId, logId, message);
      } else {
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
      }
      
      // Log the manual reply
      await pool.query(
        `INSERT INTO automation_logs 
         (platform, trigger_type, trigger_text, media_id, sender_id, account_id, 
          automation_id, automation_name, response_type, response_content, reply_location, success)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          platform,
          'manual_reply',
          null,
          null,
          null,
          account_id,
          null,
          'Manual Reply',
          'text',
          message,
          trigger_type === 'dm' || trigger_type === 'message' ? 'message' : 'comment',
          true
        ]
      );
      
      res.json({ success: true, reply_id: replyId });
    } catch (err) {
      console.error('Error sending reply:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
