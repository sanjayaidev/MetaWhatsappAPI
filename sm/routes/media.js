const express = require('express');
const multer = require('multer');
const { decrypt, signMediaToken, verifyMediaToken } = require('../lib/crypto');
const drive = require('../lib/googleDrive');

// 200MB cap — plenty for IG/FB images and short-form video, keeps memory use bounded
// since we buffer in memory before forwarding to Drive.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PROXY_URL_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — long enough that a scheduled post never finds it expired

async function getDriveConnection(pool, userId) {
  const res = await pool.query(
    `SELECT * FROM connections WHERE platform='google_drive' AND is_connected=true AND user_id=$1 ORDER BY updated_at DESC LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// Stored value is normally a refresh token (see finishGoogle in
// routes/connections.js), which must be exchanged for a fresh short-lived
// access token before every Drive call. If that exchange fails — expired/
// revoked refresh token — surface a clear "reconnect" error instead of a
// confusing raw Google 401.
async function getWorkingAccessToken(conn) {
  const stored = decrypt(conn.access_token);
  try {
    return await drive.getFreshAccessToken(stored);
  } catch (err) {
    const e = new Error('Google Drive connection expired or was revoked — please reconnect Google Drive in the Connections tab.');
    e.needsReconnect = true;
    throw e;
  }
}

// ===========================================================
// PROTECTED router: upload a file to the user's own connected Drive.
// Mounted behind requireAuth in server.js.
// ===========================================================
function router(pool) {
  const r = express.Router();

  r.post('/upload', upload.single('file'), async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      if (!req.file) return res.status(400).json({ error: 'No file uploaded — attach it under the "file" field' });

      const conn = await getDriveConnection(pool, userId);
      if (!conn) {
        return res.status(400).json({ error: 'Connect Google Drive first (Connections tab) before uploading media' });
      }
      const token = await getWorkingAccessToken(conn);

      const uploaded = await drive.uploadFile(token, {
        buffer: req.file.buffer,
        filename: req.file.originalname || `upload-${Date.now()}`,
        mimeType: req.file.mimetype || 'application/octet-stream',
      });

      const expiresAt = Date.now() + PROXY_URL_TTL_MS;
      const sig = signMediaToken(userId, uploaded.id, expiresAt);
      const mediaUrl = `${APP_BASE_URL}/api/media/stream/${userId}/${uploaded.id}?exp=${expiresAt}&sig=${sig}`;

      res.json({
        google_drive_file_id: uploaded.id,
        filename: uploaded.name,
        media_url: mediaUrl,
      });
    } catch (err) {
      if (err.needsReconnect) return res.status(401).json({ error: err.message });
      const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      res.status(500).json({ error: message });
    }
  });

  return r;
}

// ===========================================================
// PUBLIC router: streams the file from the owner's Drive so Meta's
// (or LinkedIn's) servers can fetch it as a normal public image/video URL.
// Mounted WITHOUT requireAuth — signature + expiry (see lib/crypto.js) is
// what stops this being an open proxy to arbitrary files.
// ===========================================================
function streamRouter(pool) {
  const r = express.Router();

  r.get('/stream/:userId/:fileId', async (req, res) => {
    const { userId, fileId } = req.params;
    const { exp, sig } = req.query;

    if (!exp || !sig || !verifyMediaToken(userId, fileId, exp, sig)) {
      return res.status(403).send('Invalid or expired media link');
    }

    try {
      const conn = await getDriveConnection(pool, userId);
      if (!conn) return res.status(404).send('Drive account no longer connected');
      const token = await getWorkingAccessToken(conn);

      const meta = await drive.getFileMeta(token, fileId);
      const upstream = await drive.getFileStream(token, fileId);

      res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
      if (meta.size) res.setHeader('Content-Length', meta.size);
      upstream.data.pipe(res);
    } catch (err) {
      if (err.needsReconnect) return res.status(401).send(err.message);
      res.status(500).send('Failed to stream media');
    }
  });

  return r;
}

module.exports = router;
module.exports.router = router;
module.exports.streamRouter = streamRouter;
