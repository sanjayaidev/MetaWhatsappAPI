const express = require('express');
const { generateReply, getAvailableModels, isAllowedModel } = require('../lib/ai');

function router(pool) {
  const r = express.Router();

  // GET /api/ai/models - List available AI models
  r.get('/models', (req, res) => {
    const models = getAvailableModels();
    res.json(models);
  });

  // POST /api/ai/reply - Generate AI reply using NVIDIA API with MistralAI models
  r.post('/reply', async (req, res) => {
    try {
      const { messages, model, temperature, max_tokens, stream } = req.body;

      // Validate messages
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ 
          error: 'Messages array is required and must not be empty' 
        });
      }

      // Validate each message has role and content
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.role || typeof msg.content !== 'string') {
          return res.status(400).json({ 
            error: `Message at index ${i} must have role and content` 
          });
        }
        if (!['user', 'assistant', 'system'].includes(msg.role)) {
          return res.status(400).json({ 
            error: `Message role must be 'user', 'assistant', or 'system', got '${msg.role}'` 
          });
        }
      }

      // Call the AI generation function
      const result = await generateReply(messages, {
        model,
        temperature,
        max_tokens,
        stream,
      });

      res.json(result);
    } catch (err) {
      console.error('AI reply error:', err.message);
      
      // Handle specific error cases
      if (err.message.includes('NVIDIA_API_KEY')) {
        return res.status(500).json({ 
          error: 'AI service is not configured. Please set NVIDIA_API_KEY environment variable.' 
        });
      }
      
      if (err.message.includes('not allowed')) {
        return res.status(403).json({ 
          error: err.message,
          allowed_models: getAvailableModels().models
        });
      }

      res.status(500).json({ 
        error: 'Failed to generate AI reply', 
        details: err.message 
      });
    }
  });

  // POST /api/ai/generate - Simple prompt-based generation (legacy compatibility)
  r.post('/generate', async (req, res) => {
    try {
      const { prompt, model, temperature, max_tokens } = req.body;

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        return res.status(400).json({ 
          error: 'Prompt is required' 
        });
      }

      // Convert single prompt to messages format
      const messages = [
        { role: 'user', content: prompt }
      ];

      const result = await generateReply(messages, {
        model,
        temperature,
        max_tokens,
      });

      res.json(result);
    } catch (err) {
      console.error('AI generate error:', err.message);
      
      if (err.message.includes('NVIDIA_API_KEY')) {
        return res.status(500).json({ 
          error: 'AI service is not configured. Please set NVIDIA_API_KEY environment variable.' 
        });
      }

      res.status(500).json({ 
        error: 'Failed to generate AI reply', 
        details: err.message 
      });
    }
  });

  return r;
}

module.exports = router;
