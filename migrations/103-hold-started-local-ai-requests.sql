BEGIN;
-- A revision retires its parent's permission. An attempt that started may have
-- reached the AI boundary, so it is held with an unknown outcome and never
-- closed. Only a request that never started can be cancelled. Metered requests
-- already resolve through the receipt trigger before this job update runs.
CREATE OR REPLACE FUNCTION retire_parent_local_ai_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision_parent_id IS NOT NULL THEN
  UPDATE local_ai_receipts SET withdrawn_at=clock_timestamp()
   WHERE evidence_id=NEW.revision_parent_id AND withdrawn_at IS NULL;
  UPDATE adapter_jobs SET
   status=CASE WHEN attempt_count>0 THEN 'needs_reconciliation' ELSE 'exhausted' END,
   safe_error=CASE WHEN attempt_count>0 THEN 'provider_outcome_unknown' ELSE 'provider_unavailable' END,
   attempt_token=NULL,lease_until=NULL,provider_operation_reference=NULL,updated_at=clock_timestamp()
   WHERE local_ai_receipt_id IN (
     SELECT id FROM local_ai_receipts WHERE evidence_id=NEW.revision_parent_id
   ) AND status IN ('pending','failed','running');
 END IF;
 RETURN NEW;
END $$;
INSERT INTO schema_migrations(version) VALUES(103) ON CONFLICT DO NOTHING;
COMMIT;
