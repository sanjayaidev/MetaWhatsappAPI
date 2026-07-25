// src/smc-bridge.js — links a CRM user (Supabase Auth) to the matching
// smc_users row (sm's own email/password user table) so the CRM can call
// straight into sm's existing routers (sm/routes/connections.js,
// sm/routes/comments.js) and hit the SAME smc_connections /
// smc_automation_logs rows sm itself uses — not a duplicate table, not a
// duplicate OAuth app, not a second "connect your accounts" flow.
//
// Both apps live in this one server process (see server.js) and share the
// same Supabase project, so the only real gap is identity: CRM users are
// Supabase Auth UUIDs, sm users are smc_users.id (serial). This bridges
// that gap by matching on email — confirmed to be the same email for both
// in practice for this deployment.
//
// The smc_users row this creates is NEVER used to log into /sm directly —
// callers here always go through a JWT minted with mintSmcToken, never
// smc's own /login endpoint — so its password_hash is a random placeholder,
// not a real credential.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';

module.exports = function createSmcBridge(supabase) {
  // Finds the smc_users row matching this CRM user's email, or creates one.
  // Concurrent first-requests racing to create the same row are handled via
  // a retry-on-conflict rather than a lock, since smc_users.email is unique.
  async function getOrCreateSmcUser(crmUser) {
    const email = crmUser && crmUser.email;
    if (!email) throw new Error('CRM account has no email on file');

    const { data: existing, error: findErr } = await supabase
      .from('smc_users')
      .select('id, email, name')
      .eq('email', email)
      .maybeSingle();
    if (findErr) throw findErr;
    if (existing) return existing;

    const placeholderHash = 'crm-bridge:' + crypto.randomBytes(32).toString('hex');
    const name = crmUser.user_metadata?.full_name || crmUser.user_metadata?.name || null;

    const { data: created, error: createErr } = await supabase
      .from('smc_users')
      .insert({ email, password_hash: placeholderHash, name })
      .select('id, email, name')
      .single();
    if (createErr) {
      if (createErr.code === '23505') { // unique_violation — another request created it first
        const { data: retry, error: retryErr } = await supabase
          .from('smc_users').select('id, email, name').eq('email', email).maybeSingle();
        if (retryErr) throw retryErr;
        if (retry) return retry;
      }
      throw createErr;
    }
    return created;
  }

  // Short-lived — only needs to survive the redirect hop through Meta's
  // OAuth dialog and back, same expiry sm itself uses for its own state JWTs.
  function mintSmcToken(smcUserId, email) {
    return jwt.sign({ sub: smcUserId, email }, JWT_SECRET, { expiresIn: '10m' });
  }

  // Express middleware: resolves the linked smc_users identity and
  // OVERWRITES req.user with it (shape: { id, sub, email }) so that sm's
  // route handlers — which read req.user.id || req.user.sub and were
  // written for smc's own requireAuth — work completely unmodified when
  // mounted a second time under a CRM-facing path. The original CRM user
  // is preserved on req.crmUser in case a wrapping route needs it.
  async function mapToSmcUser(req, res, next) {
    try {
      const smcUser = await getOrCreateSmcUser(req.user);
      req.crmUser = req.user;
      req.user = { id: smcUser.id, sub: smcUser.id, email: smcUser.email };
      next();
    } catch (err) {
      res.status(500).json({ error: 'Could not link social account: ' + err.message });
    }
  }

  return { getOrCreateSmcUser, mintSmcToken, mapToSmcUser };
};
