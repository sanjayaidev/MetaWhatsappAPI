-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM — Migration 004
-- Adds columns to wb_sheet_watchers for:
--   - recurrence_type: 'yearly' (day+month) or 'monthly' (day only)
--   - status_column: column name to check before sending (e.g., 'Send Reminder')
--   - sent_status_column: column name where server marks sent status (e.g., 'Reminder Sent')
-- Run this AFTER 003.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE wb_sheet_watchers
ADD COLUMN IF NOT EXISTS recurrence_type TEXT DEFAULT 'yearly' CHECK (recurrence_type IN ('yearly', 'monthly')),
ADD COLUMN IF NOT EXISTS status_column TEXT,
ADD COLUMN IF NOT EXISTS sent_status_column TEXT;

COMMENT ON COLUMN wb_sheet_watchers.recurrence_type IS 'yearly = reminder on specific date each year (birthday), monthly = reminder on same day each month (fee due date)';
COMMENT ON COLUMN wb_sheet_watchers.status_column IS 'Column name to check before sending (e.g., "Send Reminder"). Server reads this to decide whether to send.';
COMMENT ON COLUMN wb_sheet_watchers.sent_status_column IS 'Column name where server marks sent status (e.g., "Reminder Sent"). Server updates this after sending.';
