-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM — Migration 003
-- Adds send_time column to wb_sheet_watchers for scheduling
-- message delivery at specific times when date reminders approach.
-- Run this AFTER 002.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE wb_sheet_watchers 
ADD COLUMN IF NOT EXISTS send_time TIME DEFAULT '09:00:00';

COMMENT ON COLUMN wb_sheet_watchers.send_time IS 'Time of day to send date reminder messages (e.g., 09:00 for 9 AM). Only applies to date_reminder watch_type.';
