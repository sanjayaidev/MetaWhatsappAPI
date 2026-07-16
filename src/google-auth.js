// src/google-auth.js — keeps a user's Google OAuth access token valid.
//
// Root cause of "Failed to load sheets — try reconnecting":
// wb_oauth_tokens.access_token_enc is a short-lived Google access token
// (~1 hour). refresh_token_enc was being stored on connect but never used,
// so once the access token expired every Sheets/Drive call 401'd and the
// only fix was disconnect + reconnect. This module refreshes the access
// token on demand using the stored refresh_token and persists the result,
// so callers always get a working token without the user doing anything.
module.exports = function createGoogleAuthHelper({ supabase, encryptToken, decryptToken, fetch }) {
  // Refresh a bit before actual expiry to avoid a race against in-flight requests.
  const EXPIRY_SAFETY_MARGIN_MS = 2 * 60 * 1000;

  async function refreshAccessToken(tokenRow) {
    if (!tokenRow.refresh_token_enc) {
      throw new Error('Google not connected (no refresh token on file) — please reconnect from the CRM.');
    }
    const refreshToken = decryptToken(tokenRow.refresh_token_enc);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      // A revoked/expired refresh token means the user genuinely has to reconnect —
      // surface that distinctly from a transient network error.
      if (tokenData.error === 'invalid_grant') {
        throw new Error('Google access was revoked — please reconnect Google Sheets from the CRM.');
      }
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to refresh Google token');
    }

    const patch = {
      access_token_enc: encryptToken(tokenData.access_token),
      expires_at: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null,
      updated_at: new Date().toISOString()
    };
    // Google only returns a new refresh_token occasionally (e.g. re-consent) — keep the old one otherwise.
    if (tokenData.refresh_token) patch.refresh_token_enc = encryptToken(tokenData.refresh_token);

    await supabase.from('wb_oauth_tokens').update(patch).eq('id', tokenRow.id);
    return tokenData.access_token;
  }

  // Returns a valid, decrypted Google access token for this user, transparently
  // refreshing it first if it's missing/expired/about to expire.
  async function getValidGoogleAccessToken(userId) {
    const { data: tokenRow, error } = await supabase.from('wb_oauth_tokens')
      .select('*').eq('user_id', userId).eq('service', 'google').single();
    if (error || !tokenRow || !tokenRow.access_token_enc) {
      throw new Error('Google not connected — please connect Google Sheets from the CRM.');
    }

    const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
    const isExpiringSoon = !expiresAt || (expiresAt - Date.now()) < EXPIRY_SAFETY_MARGIN_MS;

    if (!isExpiringSoon) {
      return decryptToken(tokenRow.access_token_enc);
    }
    return refreshAccessToken(tokenRow);
  }

  return { getValidGoogleAccessToken };
};