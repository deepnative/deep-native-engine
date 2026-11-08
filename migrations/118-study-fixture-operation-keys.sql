BEGIN;
-- #42 A study fixture operation key is unique only within the actor who used
-- it, so another actor's key reads and acts exactly like an unused one. Erased
-- receipts keep a NULL actor and no longer reserve the key for anyone.
ALTER TABLE browser_study_fixture_operations DROP CONSTRAINT IF EXISTS browser_study_fixture_operations_pkey;
ALTER TABLE browser_study_fixture_operations ALTER COLUMN operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS browser_study_fixture_operations_actor_key ON browser_study_fixture_operations(actor_id,operation_id);
INSERT INTO schema_migrations(version) VALUES(118) ON CONFLICT DO NOTHING;
COMMIT;
