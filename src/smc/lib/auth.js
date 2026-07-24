const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';

// Multi-client auth: users table in PostgreSQL
async function register(pool, email, password, name = null) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return { error: 'Email already registered' };
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
    [email, passwordHash, name]
  );
  const user = result.rows[0];
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  return { user, token };
}

async function login(pool, email, password) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
  if (result.rows.length === 0) {
    return { error: 'Invalid credentials' };
  }
  const user = result.rows[0];
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
