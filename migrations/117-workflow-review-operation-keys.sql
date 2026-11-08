BEGIN;
-- #42 A workflow review operation key is unique only within the actor who used
-- it, so another member's or administrator's key reads and acts exactly like an
-- unused one. Erased receipts keep a NULL actor and no longer reserve the key.
ALTER TABLE workflow_review_operations DROP CONSTRAINT IF EXISTS workflow_review_operations_pkey;
ALTER TABLE workflow_review_operations ALTER COLUMN operation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_review_operations_actor_key ON workflow_review_operations(actor_id,operation_id);
INSERT INTO schema_migrations(version) VALUES(117) ON CONFLICT DO NOTHING;
COMMIT;
