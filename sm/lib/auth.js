const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';

// Multi-client auth: smc_users table, read/written via Supabase's REST API
// (PostgREST) instead of a raw pg connection — see server.js's banner for
// why the rest of this app avoids the `pg` driver.
async function register(supabase, email, password, name = null) {
  const { data: existing, error: existingErr } = await supabase
    .from('smc_users')
    .select('id')
    .eq('email', email)
    .limit(1);
  if (existingErr) throw existingErr;
  if (existing && existing.length > 0) {
    return { error: 'Email already registered' };
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const { data: user, error } = await supabase
    .from('smc_users')
    .insert({ email, password_hash: passwordHash, name })
    .select('id, email, name')
    .single();
  if (error) throw error;
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  return { user, token };
}

async function login(supabase, email, password) {
  const { data: user, error } = await supabase
    .from('smc_users')
    .select('*')
    .eq('email', email)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  if (!user) {
    return { error: 'Invalid credentials' };
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return { error: 'Invalid credentials' };
  }
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  return { user: { id: user.id, email: user.email, name: user.name }, token };
}

// Middleware for JWT token authentication
function requireAuth(req, res, next) {
  // Try session first
  if (req.session && req.session.userId) {
    req.user = { id: req.session.userId, email: req.session.email };
    return next();
  }

  // Fall back to JWT token
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { login, register, requireAuth };
