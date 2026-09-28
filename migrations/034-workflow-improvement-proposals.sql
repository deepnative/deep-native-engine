BEGIN;
ALTER TABLE member_proposals
 ADD COLUMN IF NOT EXISTS workflow_id text,
 ADD COLUMN IF NOT EXISTS workflow_version integer;
DO $$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conname='member_proposals_workflow_reference_pair'
 ) THEN
   ALTER TABLE member_proposals
   ADD CONSTRAINT member_proposals_workflow_reference_pair CHECK (
     (workflow_id IS NULL AND workflow_version IS NULL) OR
     (workflow_id ~ '^WF-[0-9]{3}$' AND workflow_version > 0)
   );
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(34) ON CONFLICT DO NOTHING;
COMMIT;
