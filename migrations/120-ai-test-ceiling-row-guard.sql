BEGIN;
-- #188 The test spending ceiling row changes only through its recorded paths:
-- a platform administrator's change record (migration 117) sets the ceiling,
-- and spending commitments (migration 116) move the committed total. A direct
-- statement against the row is refused, so no ceiling change goes unrecorded
-- and recorded spend cannot be reset. The row cannot be removed, so dispatch
-- never loses its ceiling. Test setup that needs a known value suspends these
-- triggers explicitly, which needs table ownership.
CREATE OR REPLACE FUNCTION guard_ai_test_ceiling_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN
  RAISE EXCEPTION 'AI test ceiling cannot be removed';
 END IF;
 -- Only the recorded paths, which run inside their own triggers, may write.
 IF TG_OP='INSERT' OR pg_trigger_depth()<2
    OR NEW.singleton IS DISTINCT FROM OLD.singleton
    OR NEW.rate_version IS DISTINCT FROM OLD.rate_version
    OR (NEW.ceiling_points IS DISTINCT FROM OLD.ceiling_points
     AND (NEW.committed_points IS DISTINCT FROM OLD.committed_points
      OR COALESCE(current_setting('dne.ai_test_ceiling_change',true),'')
       <> OLD.ceiling_points||':'||NEW.ceiling_points))
 THEN
  RAISE EXCEPTION 'AI test ceiling changes only through a recorded change';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_test_ceiling_row_guard ON ai_test_spending_ceiling;
CREATE TRIGGER ai_test_ceiling_row_guard BEFORE INSERT OR UPDATE OR DELETE
 ON ai_test_spending_ceiling FOR EACH ROW EXECUTE FUNCTION guard_ai_test_ceiling_row();
DROP TRIGGER IF EXISTS ai_test_ceiling_truncate_guard ON ai_test_spending_ceiling;
CREATE TRIGGER ai_test_ceiling_truncate_guard BEFORE TRUNCATE
 ON ai_test_spending_ceiling FOR EACH STATEMENT EXECUTE FUNCTION guard_ai_test_ceiling_row();

-- Same as migration 117, except that the record marks the one ceiling change
-- it makes, for the row guard above, and clears the mark straight after.
CREATE OR REPLACE FUNCTION guard_ai_test_ceiling_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'AI test ceiling changes are immutable';
 END IF;
 IF TG_OP='UPDATE' THEN
  -- Only the administrator link may clear, and only once its account is gone.
  IF (to_jsonb(NEW)-'administrator_id') IS DISTINCT FROM (to_jsonb(OLD)-'administrator_id')
   OR NOT (NEW.administrator_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.administrator_id))
  THEN RAISE EXCEPTION 'AI test ceiling changes are immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM principals p JOIN authorized_staff_profiles s ON s.principal_id=p.id
  WHERE p.id=NEW.administrator_id AND p.kind='staff' AND s.role='platform_admin'
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
 ) THEN RAISE EXCEPTION 'AI test ceiling change authority unavailable'; END IF;
 -- The record describes the ceiling it replaced and the spend at that moment.
 PERFORM set_config('dne.ai_test_ceiling_change',
  NEW.previous_points||':'||NEW.ceiling_points,true);
 UPDATE ai_test_spending_ceiling SET ceiling_points=NEW.ceiling_points
  WHERE singleton AND ceiling_points=NEW.previous_points
   AND rate_version=NEW.rate_version AND committed_points=NEW.committed_points;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI test ceiling changed since it was read'; END IF;
 PERFORM set_config('dne.ai_test_ceiling_change','',true);
 RETURN NEW;
END $$;
INSERT INTO schema_migrations(version) VALUES(120) ON CONFLICT DO NOTHING;
COMMIT;
