// scripts/onboard-client-gateway.js — run this once per client after you've
// deployed their own PaymentGatewayAPI to Vercel and generated their
// GATEWAY_API_KEY (see generate-key.js). Encrypts the key with this app's
// existing TOKEN_ENCRYPTION_KEY and upserts it + their gateway URL into
// wb_ecom_settings, so payments.js can look it up at checkout time.
//
// Usage:
//   node scripts/onboard-client-gateway.js <user_id> <gateway_base_url> <plaintext_gateway_api_key>
//
// Example:
//   node scripts/onboard-client-gateway.js \
//     3f9c1a2e-... \
//     https://acme-corp-payments.vercel.app \
//     7fc50e252593eb600e5caed72831c94cff5ea2188e4c47b1537d54318658b1
//
// Requires the same env vars the main server uses: SUPABASE_URL,
// SUPABASE_SERVICE_KEY, TOKEN_ENCRYPTION_KEY. Run it from an environment
// that already has those (e.g. `vercel env pull` locally, or wherever you
// keep the server's .env), NOT by pasting keys into a shell history-visible
// one-liner on a shared machine.

const { createClient } = require('@supabase/supabase-js');
const { encryptToken } = require('../src/crypto');

async function main() {
  const [userId, gatewayBaseUrl, plaintextKey] = process.argv.slice(2);

  if (!userId || !gatewayBaseUrl || !plaintextKey) {
    console.error('Usage: node scripts/onboard-client-gateway.js <user_id> <gateway_base_url> <plaintext_gateway_api_key>');
    process.exit(1);
  }

  // Same validation payments.js applies at request time — catch a typo'd
  // URL here rather than at the client's first real checkout attempt.
  let parsed;
  try {
    parsed = new URL(gatewayBaseUrl);
  } catch {
    console.error(`Not a valid URL: ${gatewayBaseUrl}`);
    process.exit(1);
  }
  if (parsed.protocol !== 'https:') {
    console.error('gateway_base_url must be https');
    process.exit(1);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set in this shell — pull the server env first.');
    process.exit(1);
  }
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.error('TOKEN_ENCRYPTION_KEY not set — this must match the value the main server uses, or it won\'t be able to decrypt this later.');
    process.exit(1);
  }

  const encrypted = encryptToken(plaintextKey);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('wb_ecom_settings').upsert({
    user_id: userId,
    gateway_base_url: parsed.origin,
    gateway_api_key_encrypted: encrypted,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (error) {
    console.error('Failed to save:', error.message);
    process.exit(1);
  }

  console.log(`✅ Saved gateway config for user ${userId}`);
  console.log(`   gateway_base_url: ${parsed.origin}`);
  console.log(`   gateway_api_key_encrypted: stored (${encrypted.length} chars)`);
  console.log('\nPlaintext key was NOT stored anywhere — only the encrypted form. Keep the plaintext value somewhere safe (e.g. your password manager) in case you need to re-onboard this client to a new Vercel deployment later.');
}

main();
