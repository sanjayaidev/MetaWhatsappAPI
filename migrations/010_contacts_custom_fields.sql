-- 010_contacts_custom_fields.sql
-- Extra CSV columns (e.g. "field", "email", "city") are stored per contact as JSON and
-- copied onto each queued send so campaigns can map them to template placeholders.
-- Without these columns the contacts save fails and the extra columns are lost.

alter table wb_contacts   add column if not exists custom_fields jsonb;
alter table wb_send_queue add column if not exists custom_fields_data jsonb;

-- Make PostgREST pick up the new columns immediately.
notify pgrst, 'reload schema';
