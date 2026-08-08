// sm/lib/ownerDriveToken.js — DB-backed credential for the single shared
// "owner" Google Drive account that backs media storage for every sm/ user.
//
// This used to be GOOGLE_DRIVE_OWNER_REFRESH_TOKEN, a raw env var re-hit on
// every single Drive call and only rotatable by editing the env and
// redeploying. It's now one row in smc_shared_tokens, set/rotated manually
// from the /sm/admin/drive page (see routes/admin-drive.js) — no auto-cron,
// the operator pastes in a fresh refresh token there whenever needed.
const { encrypt, decrypt } = require('./crypto');
const drive = require('./googleDrive');

const SERVICE = 'google_drive_owner';
// Refresh a bit before actual expiry to avoid a race against in-flight requests.
const EXPIRY_SAFETY_MARGIN_MS = 2 * 60 * 1000;

async function getRow(supabase) {
  const { data, error } = await supabase
    .from('smc_shared_tokens')
    .select('*')
    .eq('service', SERVICE)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Manually called from the admin page after pasting in a refresh token.
// Validates it against Google before saving so a typo/expired token never
// silently gets stored as "connected".
async function setRefreshToken(supabase, refreshToken) {
  const accessToken = await drive.getFreshAccessToken(refreshToken);

  const patch = {
    service: SERVICE,
    refresh_token_enc: encrypt(refreshToken),
    access_token_enc: encrypt(accessToken),
    // Google access tokens are ~1hr; we don't get expires_in back from
    // getFreshAccessToken's return shape, so re-check/refresh on next use
    // rather than trusting a stale expiry here.
    expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('smc_shared_tokens')
    .upsert(patch, { onConflict: 'service' });
  if (error) throw error;

  return { connected: true, updatedAt: patch.updated_at };
}

// Returns a valid, decrypted access token for the shared owner Drive,
// transparently refreshing it first if it's missing/expired/about to expire.
async function getValidAccessToken(supabase) {
  const row = await getRow(supabase);

  if (!row) {
    const e = new Error('Shared Google Drive is not connected yet — set it up at /sm/admin/drive.');
    e.notConfigured = true;
    throw e;
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const isExpiringSoon = !expiresAt || (expiresAt - Date.now()) < EXPIRY_SAFETY_MARGIN_MS;

  if (!isExpiringSoon && row.access_token_enc) {
    return decrypt(row.access_token_enc);
  }

  const refreshToken = decrypt(row.refresh_token_enc);
  let accessToken;
  try {
    accessToken = await drive.getFreshAccessToken(refreshToken);
  } catch (err) {
    const e = new Error('The shared Google Drive connection expired or was revoked — reconnect it at /sm/admin/drive.');
    e.needsReconnect = true;
    throw e;
  }

  await supabase
    .from('smc_shared_tokens')
    .update({
      access_token_enc: encrypt(accessToken),
      expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('service', SERVICE);

  return accessToken;
}

async function getStatus(supabase) {
  const row = await getRow(supabase);
  if (!row) return { connected: false };
  return {
    connected: true,
    updatedAt: row.updated_at,
    accessTokenExpiresAt: row.expires_at,
  };
}

module.exports = { getValidAccessToken, setRefreshToken, getStatus };
