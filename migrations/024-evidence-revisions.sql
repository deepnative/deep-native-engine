BEGIN;
ALTER TABLE evidence_objects
 ADD COLUMN IF NOT EXISTS revision_parent_id uuid
 REFERENCES evidence_objects(id) ON DELETE SET NULL;
ALTER TABLE evidence_objects
 ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1
 CHECK(revision_number BETWEEN 1 AND 20);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_objects_one_revision_per_parent_idx
 ON evidence_objects(revision_parent_id)
 WHERE revision_parent_id IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES(24) ON CONFLICT DO NOTHING;
COMMIT;
