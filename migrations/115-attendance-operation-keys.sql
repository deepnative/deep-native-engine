BEGIN;
-- #42 An attendance operation key is unique only within the actor who used it,
-- so another actor's key reads and acts exactly like an unused one. Erased
-- receipts keep a NULL actor and no longer reserve the key for anyone.
ALTER TABLE private_event_attendance_operations DROP CONSTRAINT IF EXISTS private_event_attendance_operations_pkey;
ALTER TABLE private_event_attendance_operations ALTER COLUMN operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS private_event_attendance_operations_actor_key ON private_event_attendance_operations(actor_id,operation_id);
INSERT INTO schema_migrations(version) VALUES(115) ON CONFLICT DO NOTHING;
COMMIT;
