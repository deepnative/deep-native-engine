BEGIN;
CREATE TABLE IF NOT EXISTS local_ai_receipts (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,
 evidence_id uuid NOT NULL,
 revision_number integer NOT NULL CHECK(revision_number BETWEEN 1 AND 20),
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 purpose text NOT NULL CHECK(purpose='evidence-summary-local-v1'),
 statement_version text NOT NULL CHECK(statement_version='local-simulation-v1'),
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz CHECK(withdrawn_at>=granted_at),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(evidence_id,workspace_id) REFERENCES evidence_objects(id,workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS local_ai_current_receipt_idx
 ON local_ai_receipts(evidence_id,purpose) WHERE withdrawn_at IS NULL;
CREATE OR REPLACE FUNCTION local_ai_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD)-'withdrawn_at')
    OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
    OR NEW.withdrawn_at IS NULL THEN
  RAISE EXCEPTION 'Local AI receipt is immutable except first withdrawal';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_ai_receipt_guard ON local_ai_receipts;
CREATE TRIGGER local_ai_receipt_guard BEFORE UPDATE ON local_ai_receipts
 FOR EACH ROW EXECUTE FUNCTION local_ai_receipt_immutable();
ALTER TABLE adapter_jobs ADD COLUMN IF NOT EXISTS local_ai_receipt_id uuid
 REFERENCES local_ai_receipts(id) ON DELETE CASCADE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='adapter_jobs_local_ai_check') THEN
 ALTER TABLE adapter_jobs ADD CONSTRAINT adapter_jobs_local_ai_check CHECK(
 local_ai_receipt_id IS NULL OR (member_id IS NOT NULL AND adapter='ai' AND mode IN ('demo','test')
 AND operation='evidence-summary-local-v1' AND prompt_template_version='local-simulation-v1'
 AND model_contract_version='deterministic-local-v1'));
 END IF;
END $$;
-- Inserting a revision permanently retires the parent's authorization, even
-- if the new source is later deleted. The existing lineage guard locks the
-- parent source before this AFTER trigger takes receipt and then job locks.
CREATE OR REPLACE FUNCTION retire_parent_local_ai_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision_parent_id IS NOT NULL THEN
  UPDATE local_ai_receipts SET withdrawn_at=clock_timestamp()
   WHERE evidence_id=NEW.revision_parent_id AND withdrawn_at IS NULL;
  UPDATE adapter_jobs SET status='exhausted',attempt_token=NULL,lease_until=NULL,
   safe_error='provider_unavailable',updated_at=clock_timestamp()
   WHERE local_ai_receipt_id IN (
     SELECT id FROM local_ai_receipts WHERE evidence_id=NEW.revision_parent_id
   ) AND status IN ('pending','failed','running');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evidence_revision_local_ai_retirement ON evidence_objects;
CREATE TRIGGER evidence_revision_local_ai_retirement AFTER INSERT ON evidence_objects
 FOR EACH ROW EXECUTE FUNCTION retire_parent_local_ai_permission();
INSERT INTO schema_migrations(version) VALUES(39) ON CONFLICT DO NOTHING;
COMMIT;
