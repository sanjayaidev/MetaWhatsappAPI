const express = require('express');
const multer = require('multer');
const { decrypt, signMediaToken, verifyMediaToken } = require('../lib/crypto');
const drive = require('../lib/googleDrive');

// 200MB cap — plenty for IG/FB images and short-form video, keeps memory use bounded
// since we buffer in memory before forwarding to Drive.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
// Ensure /sm prefix is included when mounted inside the main WaBlast server
const MEDIA_PATH_PREFIX = process.env.SM_MEDIA_PATH_PREFIX || '/sm';
const PROXY_URL_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — long enough that a scheduled post never finds it expired

// One pre-connected Google account (the app operator's own Drive) backs
// media storage for every user — set up once, outside the per-user OAuth
// consent flow, since Drive access was never part of our verified scope
// grant. Get this refresh token once by running the normal Google OAuth
// consent flow for this app's own Cloud project with the operator's Google
// account and the 'https://www.googleapis.com/auth/drive.file' scope
// (that flow doesn't need public verification since only the operator ever
// sees that consent screen), then set it here.
const OWNER_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_OWNER_REFRESH_TOKEN;

// Exchanges the shared owner refresh token for a fresh short-lived access
// token before every Drive call. If that exchange fails — expired/revoked
// refresh token — surface a clear "needs reconfiguring" error instead of a
// confusing raw Google 401 (this is an operator-level problem, not
// something any individual user can fix by reconnecting anything).
async function getSharedAccessToken() {
  if (!OWNER_REFRESH_TOKEN) {
    const e = new Error('Media storage is not configured on this server yet — set GOOGLE_DRIVE_OWNER_REFRESH_TOKEN.');
    e.notConfigured = true;
    throw e;
  }
  try {
    return await drive.getFreshAccessToken(OWNER_REFRESH_TOKEN);
  } catch (err) {
    const e = new Error('The shared Google Drive connection expired or was revoked — an admin needs to reauthorize it.');
    e.needsReconnect = true;
    throw e;
  }
}

// ===========================================================
// PROTECTED router: upload a file to the shared owner Drive.
// Mounted behind requireAuth in server.js.
// ===========================================================
function router(supabase) {
  const r = express.Router();

  r.post('/upload', upload.single('file'), async (req, res) => {
    try {
      const userId = req.user.id || req.user.sub;
      if (!req.file) return res.status(400).json({ error: 'No file uploaded — attach it under the "file" field' });

      const token = await getSharedAccessToken();

      const uploaded = await drive.uploadFile(token, {
        buffer: req.file.buffer,
        filename: req.file.originalname || `upload-${Date.now()}`,
        mimeType: req.file.mimetype || 'application/octet-stream',
      });

      const expiresAt = Date.now() + PROXY_URL_TTL_MS;
      const sig = signMediaToken(userId, uploaded.id, expiresAt);
      const mediaUrl = `${APP_BASE_URL}${MEDIA_PATH_PREFIX}/api/media/stream/${userId}/${uploaded.id}?exp=${expiresAt}&sig=${sig}`;

      res.json({
        google_drive_file_id: uploaded.id,
        filename: uploaded.name,
        media_url: mediaUrl,
      });
    } catch (err) {
      if (err.notConfigured || err.needsReconnect) return res.status(503).json({ error: err.message });
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
// what stops this being an open proxy to arbitrary files. userId in the
// path is still verified against the signature so one user's signed link
// can't be replayed to fetch a different user's fileId.
// ===========================================================
function streamRouter(supabase) {
  const r = express.Router();

  r.get('/stream/:userId/:fileId', async (req, res) => {
    const { userId, fileId } = req.params;
    const { exp, sig } = req.query;

    if (!exp || !sig || !verifyMediaToken(userId, fileId, exp, sig)) {
      return res.status(403).send('Invalid or expired media link');
    }

    try {
      const token = await getSharedAccessToken();

      const meta = await drive.getFileMeta(token, fileId);
      const upstream = await drive.getFileStream(token, fileId);

      res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
      if (meta.size) res.setHeader('Content-Length', meta.size);
      upstream.data.pipe(res);
    } catch (err) {
      if (err.notConfigured || err.needsReconnect) return res.status(503).send(err.message);
      res.status(500).send('Failed to stream media');
    }
  });

  return r;
}

module.exports = router;
module.exports.router = router;
module.exports.streamRouter = streamRouter;
module.exports.getSharedAccessToken = getSharedAccessToken;