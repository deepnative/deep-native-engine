BEGIN;
-- A revision is unique only within one surviving feedback row. Deleting and
-- recreating identical text at revision1 must never restore an older reader's
-- permission. Backfill existing rows once without touching text or revision.
ALTER TABLE workflow_feedback ADD COLUMN IF NOT EXISTS instance_id uuid;
UPDATE workflow_feedback SET instance_id=gen_random_uuid() WHERE instance_id IS NULL;
ALTER TABLE workflow_feedback ALTER COLUMN instance_id SET DEFAULT gen_random_uuid();
ALTER TABLE workflow_feedback ALTER COLUMN instance_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_feedback_instance_idx ON workflow_feedback(instance_id);

CREATE OR REPLACE FUNCTION guard_workflow_feedback_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.instance_id IS DISTINCT FROM OLD.instance_id
 THEN RAISE EXCEPTION 'Private feedback source identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_feedback_instance_guard ON workflow_feedback;
CREATE TRIGGER workflow_feedback_instance_guard BEFORE UPDATE ON workflow_feedback
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_feedback_instance();

INSERT INTO schema_migrations(version) VALUES(64) ON CONFLICT DO NOTHING;
COMMIT;
