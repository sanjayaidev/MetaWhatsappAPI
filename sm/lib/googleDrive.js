const axios = require('axios');

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const API_URL = 'https://www.googleapis.com/drive/v3/files';

// connections.access_token for google_drive/google_sheets actually stores the
// long-lived REFRESH token (see finishGoogle in routes/connections.js), not a
// usable access token — Google access tokens expire in ~1hr, so every Drive
// call here must first mint a fresh one from the refresh token.
async function getFreshAccessToken(refreshToken) {
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
  );
  return res.data.access_token;
}

// Uploads a buffer to the user's own Drive via a multipart/related request
// (metadata + raw bytes in one request — Drive's "simple multipart" upload).
// Files land in the user's My Drive root inside a "SMClient Uploads" folder
// (created lazily) rather than scattered loose, but nothing here makes the
// file public — it stays private to the user's Drive.
async function ensureUploadsFolder(token) {
  const q = encodeURIComponent("name='SMClient Uploads' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const search = await axios.get(`${API_URL}?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (search.data.files && search.data.files.length > 0) {
    return search.data.files[0].id;
  }
  const create = await axios.post(
    API_URL,
    { name: 'SMClient Uploads', mimeType: 'application/vnd.google-apps.folder' },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return create.data.id;
}

async function uploadFile(token, { buffer, filename, mimeType }) {
  const folderId = await ensureUploadsFolder(token);
  const boundary = 'smclient-' + Date.now();
  const metadata = { name: filename, mimeType, parents: [folderId] };

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await axios.post(
    `${UPLOAD_URL}?uploadType=multipart&fields=id,name,mimeType,size`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );
  return res.data; // { id, name, mimeType, size }
}

// Streams file bytes straight from the owner's Drive — used by the public
// proxy route so Meta's servers can fetch the media without ever needing
// the file to be made public/link-shared on Drive itself.
async function getFileStream(token, fileId) {
  const res = await axios.get(`${API_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'stream',
  });
  return res;
}

async function getFileMeta(token, fileId) {
  const res = await axios.get(`${API_URL}/${fileId}?fields=id,name,mimeType,size`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

module.exports = { uploadFile, getFileStream, getFileMeta, getFreshAccessToken };
