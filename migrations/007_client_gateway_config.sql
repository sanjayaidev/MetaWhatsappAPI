-- Adds per-client PaymentGatewayAPI deployment config to wb_ecom_settings,
-- replacing the old model where gateway credentials lived directly in this
-- app's own env vars (RAZORPAY_KEY_ID, STRIPE_SECRET_KEY, etc — shared
-- across every client). Each client now points at their own
-- PaymentGatewayAPI Vercel deployment with their own gateway credentials;
-- this app never touches a client's Razorpay/Stripe/PayPal/Cashfree keys.
--
-- gateway_api_key is stored encrypted (AES-256-GCM via src/crypto.js,
-- same TOKEN_ENCRYPTION_KEY used for OAuth tokens elsewhere) — never
-- plaintext, since it's the credential that authorizes real charges on
-- the client's PaymentGatewayAPI deployment.

alter table wb_ecom_settings
  add column if not exists gateway_base_url text,
  add column if not exists gateway_api_key_encrypted text;

comment on column wb_ecom_settings.gateway_base_url is
  'e.g. https://client-slug-payments.vercel.app — that client''s own PaymentGatewayAPI deployment';
comment on column wb_ecom_settings.gateway_api_key_encrypted is
  'AES-256-GCM encrypted GATEWAY_API_KEY for that deployment; decrypt with src/crypto.js decryptToken()';
