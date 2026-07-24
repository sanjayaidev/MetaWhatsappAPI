// sm/db/schema.js
//
// This used to run `CREATE TABLE IF NOT EXISTS ...` DDL for the smc_* tables
// over a raw `pg` Pool on every boot. Now that sm/ talks to Postgres through
// Supabase's REST API (PostgREST, via @supabase/supabase-js) instead of a
// direct pg connection, there is no driver here capable of running DDL —
// PostgREST only exposes data operations (select/insert/update/delete) over
// tables that already exist.
//
// Schema for the smc_* tables now lives solely in
// migrations/004_smclient_tables_with_prefix.sql. Apply it once against your
// Supabase project (SQL editor, or `psql $DATABASE_URL -f migrations/004_smclient_tables_with_prefix.sql`)
// before starting the server. initDB is kept as a no-op so existing call
// sites don't need to change.
async function initDB(_supabase) {
  console.log('ℹ️  Social Manager (smc_*) schema is managed via migrations/004_smclient_tables_with_prefix.sql — skipping runtime DDL (Supabase REST API has no DDL access).');
}

module.exports = { initDB };
