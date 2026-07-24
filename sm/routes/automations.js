const express = require('express');

// Resolves a { platform: postId } map (postId = internal posts.id, as sent by
// the client) into { platform: platformPublishedId } using posts.published_ids.
// This is the ONE place that must produce values matching what the webhook
// mediaId comparison in automations/matcher.js expects — do not inline this
// logic elsewhere.
async function resolveTargetPublishedIds(supabase, userId, target_published_ids) {
  if (!target_published_ids || typeof target_published_ids !== 'object' || !Object.keys(target_published_ids).length) {
    return null;
  }
  const resolved = {};
  for (const [platform, postId] of Object.entries(target_published_ids)) {
    if (!postId) continue;
    const { data: post, error } = await supabase
      .from('smc_posts')
      .select('id, published_ids')
      .eq('id', postId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!post) {
      const err = new Error(`target_published_ids.${platform} does not refer to one of your posts`);
      err.status = 400;
      throw err;
    }
    const platformPublishedId = (post.published_ids || {})[platform];
    if (!platformPublishedId) {
      const err = new Error(`target_published_ids.${platform}: that post has not been published to ${platform} yet, so there is no platform id to target`);
      err.status = 400;
      throw err;
    }
    resolved[platform] = String(platformPublishedId);
  }
  return Object.keys(resolved).length ? resolved : null;
}

function router(supabase) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { data, error } = await supabase
        .from('smc_automations')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      const { name, type, keywords, platforms, ai_prompt, variations, reply_location, response_type, response_data, is_active, target_post_id, target_published_ids } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      // Support both single trigger type and 'both' for comment+dm
      const validTypes = ['comment', 'dm', 'both'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `type must be "comment", "dm", or "both", got "${type}"` });
      }
      let targetPostId = null;
      let processedTargetPublishedIds = null;

      // Handle new per-platform targeting (target_published_ids takes precedence)
      if (target_published_ids && typeof target_published_ids === 'object' && Object.keys(target_published_ids).length > 0) {
        try {
          processedTargetPublishedIds = await resolveTargetPublishedIds(supabase, userId, target_published_ids);
        } catch (err) {
          return res.status(err.status || 500).json({ error: err.message });
        }
      } else if (target_post_id !== undefined && target_post_id !== null && target_post_id !== '') {
        // Legacy single-post targeting
        const { data: postCheck, error: postCheckErr } = await supabase
          .from('smc_posts')
          .select('id')
          .eq('id', target_post_id)
          .eq('user_id', userId)
          .maybeSingle();
        if (postCheckErr) throw postCheckErr;
        if (!postCheck) {
          return res.status(400).json({ error: 'target_post_id does not refer to one of your posts' });
        }
        targetPostId = postCheck.id;
      }

      // Process response_data to extract variations and ai_prompt for backward compatibility
      let processedVariations = variations || [];
      let processedAiPrompt = ai_prompt || null;

      if (response_data) {
        // Extract variations from response_data if present
        if (response_data.variations && Array.isArray(response_data.variations)) {
          processedVariations = response_data.variations;
        }
        // Also check for comment-specific variations
        if (response_data.comment && response_data.comment.variations) {
          processedVariations = response_data.comment.variations;
        }
        // Extract ai_prompt from response_data if present
        if (response_data.system_prompt) {
          processedAiPrompt = response_data.system_prompt;
        }
        if (response_data.comment && response_data.comment.system_prompt) {
          processedAiPrompt = response_data.comment.system_prompt;
        }
      }

      const { data, error } = await supabase
        .from('smc_automations')
        .insert({
          user_id: userId,
          name,
          type,
          keywords: keywords || [],
          platforms: platforms || ['instagram', 'facebook', 'threads'],
          ai_prompt: processedAiPrompt,
          variations: processedVariations,
          reply_location: reply_location || 'comment',
          response_type: response_type || 'text',
          response_data: response_data || {},
          is_active: is_active !== undefined ? is_active : false,
          target_post_id: targetPostId,
          target_published_ids: processedTargetPublishedIds,
        })
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.patch('/:id/toggle', async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      // No SQL "SET is_active = NOT is_active" equivalent over REST — read
      // the current value first, then flip it in a second call.
      const { data: current, error: currentErr } = await supabase
        .from('smc_automations')
        .select('is_active')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (currentErr) throw currentErr;
      if (!current) {
        return res.status(404).json({ error: 'Automation not found' });
      }
      const { data, error } = await supabase
        .from('smc_automations')
        .update({ is_active: !current.is_active })
        .eq('id', req.params.id)
        .eq('user_id', userId)
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
      const { name, type, keywords, platforms, ai_prompt, variations, reply_location, response_type, response_data, is_active, target_post_id, target_published_ids } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      // Support both single trigger type and 'both' for comment+dm
      const validTypes = ['comment', 'dm', 'both'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `type must be "comment", "dm", or "both", got "${type}"` });
      }

      // Verify ownership of the automation
      const { data: existing, error: existingErr } = await supabase
        .from('smc_automations')
        .select('id')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (!existing) {
        return res.status(404).json({ error: 'Automation not found' });
      }

      let targetPostId = null;
      let processedTargetPublishedIds = null;

      // Handle new per-platform targeting (target_published_ids takes precedence)
      if (target_published_ids && typeof target_published_ids === 'object' && Object.keys(target_published_ids).length > 0) {
        try {
          processedTargetPublishedIds = await resolveTargetPublishedIds(supabase, userId, target_published_ids);
        } catch (err) {
          return res.status(err.status || 500).json({ error: err.message });
        }
      } else if (target_post_id !== undefined && target_post_id !== null && target_post_id !== '') {
        // Legacy single-post targeting
        const { data: postCheck, error: postCheckErr } = await supabase
          .from('smc_posts')
          .select('id')
          .eq('id', target_post_id)
          .eq('user_id', userId)
          .maybeSingle();
        if (postCheckErr) throw postCheckErr;
        if (!postCheck) {
          return res.status(400).json({ error: 'target_post_id does not refer to one of your posts' });
        }
        targetPostId = postCheck.id;
      }

      // Process response_data to extract variations and ai_prompt for backward compatibility
      let processedVariations = variations || [];
      let processedAiPrompt = ai_prompt || null;

      if (response_data) {
        // Extract variations from response_data if present
        if (response_data.variations && Array.isArray(response_data.variations)) {
          processedVariations = response_data.variations;
        }
        // Also check for comment-specific variations
        if (response_data.comment && response_data.comment.variations) {
          processedVariations = response_data.comment.variations;
        }
        // Extract ai_prompt from response_data if present
        if (response_data.system_prompt) {
          processedAiPrompt = response_data.system_prompt;
        }
        if (response_data.comment && response_data.comment.system_prompt) {
          processedAiPrompt = response_data.comment.system_prompt;
        }
      }

      const { data, error } = await supabase
        .from('smc_automations')
        .update({
          name,
          type,
          keywords: keywords || [],
          platforms: platforms || ['instagram', 'facebook', 'threads'],
          ai_prompt: processedAiPrompt,
          variations: processedVariations,
          reply_location: reply_location || 'comment',
          response_type: response_type || 'text',
          response_data: response_data || {},
          is_active: is_active !== undefined ? is_active : false,
          target_post_id: targetPostId,
          target_published_ids: processedTargetPublishedIds,
        })
        .eq('id', req.params.id)
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
        .from('smc_automations')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', userId);
      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}

module.exports = router;
