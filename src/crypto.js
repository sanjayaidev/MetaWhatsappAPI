// src/crypto.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
    const keyBase64 = process.env.TOKEN_ENCRYPTION_KEY;
    if (!keyBase64) throw new Error('TOKEN_ENCRYPTION_KEY env var is not set');
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
    return key;
}

function encryptToken(plaintext) {
    const key = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([encrypted, authTag]);
    
    return `${iv.toString('base64')}:${combined.toString('base64')}`;
}

function decryptToken(stored) {
    const [ivB64, combinedB64] = stored.split(':');
    if (!ivB64 || !combinedB64) throw new Error('Malformed encrypted token');
    
    const key = getKey();
    const iv = Buffer.from(ivB64, 'base64');
    const combined = Buffer.from(combinedB64, 'base64');
    
    const authTag = combined.slice(-16);
    const encrypted = combined.slice(0, -16);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
