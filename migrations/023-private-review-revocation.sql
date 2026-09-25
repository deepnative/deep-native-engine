BEGIN;
-- Existing evidence may remain private after its last sharing scope is revoked.
ALTER TABLE evidence_objects DROP CONSTRAINT IF EXISTS evidence_objects_check;
ALTER TABLE evidence_objects
 ADD COLUMN IF NOT EXISTS private_review_revoked_at timestamptz;
DO $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid='evidence_objects'::regclass
     AND conname='evidence_objects_scope_or_revocation_check'
 ) THEN
   ALTER TABLE evidence_objects
    ADD CONSTRAINT evidence_objects_scope_or_revocation_check CHECK (
      private_review_allowed OR community_publication_allowed
      OR learning_circle_id IS NOT NULL OR private_review_revoked_at IS NOT NULL
    );
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(23) ON CONFLICT DO NOTHING;
COMMIT;
