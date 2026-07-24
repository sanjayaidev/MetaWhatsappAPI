const express = require('express');
const jwt = require('jsonwebtoken');
const { login, register } = require('../lib/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';

// Resolve the current user id from either the session or a Bearer JWT,
// mirroring the logic in lib/auth.js's requireAuth middleware.
function resolveUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      return payload.sub;
    } catch (err) {
      return null;
    }
  }
  return null;
}

function router(supabase) {
  const r = express.Router();

  r.post('/register', async (req, res) => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password required' });
      }
      const result = await register(supabase, email, password, name);
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      // Set session for persistence
      req.session.userId = result.user.id;
      req.session.email = result.user.email;
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password required' });
      }
      const result = await login(supabase, email, password);
      if (result.error) {
        return res.status(401).json({ error: result.error });
      }
      // Set session for persistence
      req.session.userId = result.user.id;
      req.session.email = result.user.email;
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/me', async (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { data: user, error } = await supabase
        .from('smc_users')
        .select('id, email, name')
        .eq('id', userId)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      if (!user) {
        if (req.session) req.session.destroy();
        return res.status(401).json({ error: 'User not found' });
      }
      res.json({ user });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  return r;
}

module.exports = router;
