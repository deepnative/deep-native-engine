BEGIN;
-- #188 A platform administrator may raise or lower the TEST spending ceiling
-- (invented simulated points of the current test rates, not money). Each
-- change is one immutable record written in the same transaction as the
-- change: the ceiling it replaced, the new ceiling, committed spend at that
-- moment, the rate version, the time and the administrator. Records hold no
-- member reference. Removing the administrator's account clears only that
-- link. Lowering never refunds or cancels recorded spend; it only stops new
-- dispatch claims that do not fit.
CREATE TABLE IF NOT EXISTS ai_test_spending_ceiling_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 administrator_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 idempotency_key uuid NOT NULL,
 rate_version text NOT NULL CHECK(rate_version ~ '^[a-z0-9-]{1,64}$'),
 previous_points bigint NOT NULL CHECK(previous_points BETWEEN 0 AND 1000000000000),
 ceiling_points bigint NOT NULL CHECK(ceiling_points BETWEEN 0 AND 1000000000000),
 committed_points bigint NOT NULL CHECK(committed_points>=0),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(previous_points<>ceiling_points)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_test_spending_ceiling_changes_key
 ON ai_test_spending_ceiling_changes(administrator_id,idempotency_key);
CREATE INDEX IF NOT EXISTS ai_test_spending_ceiling_changes_recent
 ON ai_test_spending_ceiling_changes(changed_at DESC);

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
 UPDATE ai_test_spending_ceiling SET ceiling_points=NEW.ceiling_points
  WHERE singleton AND ceiling_points=NEW.previous_points
   AND rate_version=NEW.rate_version AND committed_points=NEW.committed_points;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI test ceiling changed since it was read'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_test_ceiling_change_guard ON ai_test_spending_ceiling_changes;
CREATE TRIGGER ai_test_ceiling_change_guard BEFORE INSERT OR UPDATE OR DELETE
 ON ai_test_spending_ceiling_changes FOR EACH ROW EXECUTE FUNCTION guard_ai_test_ceiling_change();
INSERT INTO schema_migrations(version) VALUES(117) ON CONFLICT DO NOTHING;
COMMIT;
