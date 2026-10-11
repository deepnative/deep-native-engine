BEGIN;
-- Workspace erasure fences the source before deleting it. The legacy withdrawal
-- trigger intentionally skips ledger settlement while that fence is present,
-- so mark only source unavailability before FK SET NULL. Doing this at deletion
-- also repairs an explicit retry after a previously fenced erasure failed.
CREATE OR REPLACE FUNCTION guard_private_review_source_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.quarantine_state='deleting'
  AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND deleting_at IS NOT NULL)
 THEN
  UPDATE review_time_allocations SET source_unavailable_at=clock_timestamp()
   WHERE evidence_id=OLD.id AND source_unavailable_at IS NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.owner_principal_id)
  AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND deleting_at IS NULL)
  AND EXISTS(SELECT 1 FROM review_time_allocations WHERE evidence_id=OLD.id AND source_unavailable_at IS NULL)
 THEN RAISE EXCEPTION 'Review source erasure must first invalidate its allocations'; END IF;
 RETURN OLD;
END $$;
-- Rollback keeps this erasure correction and retained data; it does not restore
-- the known failed-deletion path or enable browser permission creation.
INSERT INTO schema_migrations(version) VALUES(69) ON CONFLICT DO NOTHING;
COMMIT;
