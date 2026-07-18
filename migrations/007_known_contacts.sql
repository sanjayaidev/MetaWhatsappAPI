-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM — Migration 007
-- Adds wb_known_contacts: a persistent phone -> name directory used
-- purely for display (Inbox sender names), decoupled from wb_contacts
-- (which is a campaign audience list that gets fully deleted and
-- replaced every time a new contact list is uploaded).
-- Run this AFTER 001.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wb_known_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_wb_known_contacts_user_phone ON wb_known_contacts(user_id, phone);

COMMENT ON TABLE wb_known_contacts IS 'Persistent phone->name directory for display purposes only (Inbox sender names). Unlike wb_contacts, never bulk-deleted by campaign uploads.';
