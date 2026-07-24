const crypto = require('crypto');

// ENCRYPTION_KEY must be a 32-byte key, base64-encoded. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const KEY_B64 = process.env.ENCRYPTION_KEY;
if (!KEY_B64) {
  throw new Error(
    'Missing ENCRYPTION_KEY env var. Generate one with: ' +
    `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  );
}
const KEY = Buffer.from(KEY_B64, 'base64');
if (KEY.length !== 32) {
  throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${KEY.length}`);
}

const ALGO = 'aes-256-gcm';

// Returns a single string: base64(iv):base64(authTag):base64(ciphertext)
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(packed) {
  const [ivB64, tagB64, ctB64] = String(packed).split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };

// ===========================================================
// Signed media-proxy URLs — lets Meta's servers fetch a user's privately
// stored Drive file without making it public on Drive itself. The signature
// binds userId+fileId+expiry together so a leaked URL can't be edited to
// point at a different file, and expires instead of working forever.
// ===========================================================
function signMediaToken(userId, fileId, expiresAt) {
  const payload = `${userId}:${fileId}:${expiresAt}`;
  return crypto.createHmac('sha256', KEY).update(payload).digest('base64url');
}

function verifyMediaToken(userId, fileId, expiresAt, signature) {
  if (Date.now() > Number(expiresAt)) return false;
  const expected = signMediaToken(userId, fileId, expiresAt);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  } catch {
    return false;
  }
}

module.exports.signMediaToken = signMediaToken;
module.exports.verifyMediaToken = verifyMediaToken;
