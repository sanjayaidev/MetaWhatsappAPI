// src/routes/public-inbox.js
// Login-free, read-only inbox guarded by a revocable password passed as ?pass=...
//
//   GET  /api/public/inbox?pass=XXXX            -> messages (public)
//   POST /api/admin/public-inbox/create         -> x-admin-secret; body {user_id, label?, pass?, show_phone?}
//   POST /api/admin/public-inbox/revoke         -> x-admin-secret; body {id} or {user_id} (revokes all)
//   GET  /api/admin/public-inbox/list           -> x-admin-secret
const express = require('express');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function maskPhone(p) {
  const s = String(p || '');
  if (s.length <= 6) return s;
  return s.slice(0, 4) + '•'.repeat(s.length - 7) + s.slice(-3);
}

// tiny in-memory limiter: 60 requests / minute / IP
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'x';
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(ip, rec);
  if (rec.n > 60) return res.status(429).json({ error: 'Too many requests' });
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120000) hits.delete(k); }, 120000).unref();

module.exports = function publicInboxRouter({ supabase, verifyAdmin }) {
  const router = express.Router();

  router.get('/api/public/inbox', rateLimit, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
    const pass = String(req.query.pass || '').trim();
    if (pass.length < 8) return res.status(403).json({ error: 'Invalid or revoked link' });

    const { data: key, error: kErr } = await supabase
      .from('wb_public_inbox_keys')
      .select('id, user_id, show_phone')
      .eq('pass_hash', sha256(pass))
      .is('revoked_at', null)
      .maybeSingle();
    if (kErr) return res.status(500).json({ error: 'Lookup failed' });
    if (!key) return res.status(403).json({ error: 'Invalid or revoked link' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { data, error } = await supabase
      .from('wb_public_inbox')
      .select('id, phone, contact_name, message_type, message_body, created_at')
      .eq('user_id', key.user_id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: 'Could not load messages' });

    const messages = (data || []).map((m) => ({
      id: m.id,
      phone: key.show_phone ? m.phone : maskPhone(m.phone),
      name: m.contact_name || '',
      type: m.message_type,
      body: m.message_body,
      at: m.created_at
    }));
    res.json({ success: true, count: messages.length, messages });
  });

  router.post('/api/admin/public-inbox/create', verifyAdmin, async (req, res) => {
    const { user_id, label = '', show_phone = false } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const pass = req.body.pass ? String(req.body.pass) : crypto.randomBytes(18).toString('base64url');
    if (pass.length < 8) return res.status(400).json({ error: 'pass must be at least 8 characters' });
    const { data, error } = await supabase
      .from('wb_public_inbox_keys')
      .insert({ user_id, label, show_phone: !!show_phone, pass_hash: sha256(pass) })
      .select('id')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, id: data.id, pass, link: `${base}/inbox.html?pass=${encodeURIComponent(pass)}` });
  });

  router.post('/api/admin/public-inbox/revoke', verifyAdmin, async (req, res) => {
    const { id, user_id } = req.body || {};
    if (!id && !user_id) return res.status(400).json({ error: 'id or user_id required' });
    let q = supabase.from('wb_public_inbox_keys').update({ revoked_at: new Date().toISOString() }).is('revoked_at', null);
    q = id ? q.eq('id', id) : q.eq('user_id', user_id);
    const { data, error } = await q.select('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, revoked: (data || []).length });
  });

  router.get('/api/admin/public-inbox/list', verifyAdmin, async (_req, res) => {
    const { data, error } = await supabase
      .from('wb_public_inbox_keys')
      .select('id, user_id, label, show_phone, created_at, revoked_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, keys: data });
  });

  return router;
};
