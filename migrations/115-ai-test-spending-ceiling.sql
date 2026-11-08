BEGIN;
-- #188 Test-only platform spending ceiling for metered AI requests, in the
-- invented simulated points of the current test rates. Not money and not a
-- real provider ceiling. A dispatch claim commits its estimate here before any
-- provider call; settlement moves it to the actual cost (an overrun counts in
-- full); only a known failure before the call returns it, exactly once. An
-- uncertain attempt stays committed. The counter holds no member reference, so
-- erasing a member never lowers recorded spend.
DO $$ BEGIN
 IF to_regclass('ai_test_spending_ceiling') IS NULL
    AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=115) THEN
  CREATE TABLE ai_test_spending_ceiling (
   singleton boolean PRIMARY KEY CHECK(singleton),
   rate_version text NOT NULL CHECK(rate_version ~ '^[a-z0-9-]{1,64}$'),
   ceiling_points bigint NOT NULL CHECK(ceiling_points BETWEEN 0 AND 1000000000000),
   committed_points bigint NOT NULL CHECK(committed_points>=0)
  );
  CREATE TABLE ai_spending_commitments (
   job_id uuid NOT NULL REFERENCES adapter_jobs(id) ON DELETE CASCADE,
   attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
   estimated_points integer NOT NULL CHECK(estimated_points>=0),
   state text NOT NULL CHECK(state IN ('committed','settled','restored')),
   actual_points integer CHECK(actual_points>=0),
   CHECK((state='settled')=(actual_points IS NOT NULL)),
   PRIMARY KEY(job_id,attempt)
  );
  -- Earlier started attempts: settled ones count at actual cost, unsettled
  -- ones (running or held) at their estimate.
  INSERT INTO ai_spending_commitments(job_id,attempt,estimated_points,state,actual_points)
   SELECT j.id,j.attempt_count,e.cost_points,
    CASE WHEN s.job_id IS NULL THEN 'committed' ELSE 'settled' END,s.cost_points
   FROM adapter_jobs j
   JOIN ai_usage_estimates e ON e.job_id=j.id AND e.member_id=j.member_id
   LEFT JOIN ai_usage_settlements s ON s.job_id=j.id AND s.member_id=j.member_id
   WHERE j.attempt_count BETWEEN 1 AND 3;
  -- Invented test ceiling: room for several hundred demo requests.
  INSERT INTO ai_test_spending_ceiling(singleton,rate_version,ceiling_points,committed_points)
   SELECT true,'simulated-rates-v1',100000,
    COALESCE(sum(CASE WHEN state='settled' THEN actual_points ELSE estimated_points END),0)
   FROM ai_spending_commitments;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_ai_spending_commitment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  -- Only a fresh dispatch claim of a metered request, at its stored estimate.
  IF NEW.state<>'committed' OR NEW.actual_points IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM adapter_jobs j
   JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
   JOIN ai_usage_estimates e ON e.job_id=j.id AND e.member_id=j.member_id
   WHERE j.id=NEW.job_id AND j.status='running' AND j.attempt_count=NEW.attempt
    AND e.cost_points=NEW.estimated_points
  ) THEN RAISE EXCEPTION 'AI spending commitment needs a claimed metered request'; END IF;
  UPDATE ai_test_spending_ceiling SET committed_points=committed_points+NEW.estimated_points
   WHERE singleton AND committed_points+NEW.estimated_points<=ceiling_points;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI test spending ceiling reached'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM adapter_jobs WHERE id=OLD.job_id) THEN
   RAISE EXCEPTION 'AI spending commitments are removed only with their request';
  END IF;
  -- Recorded spend stays on the counter.
  RETURN OLD;
 END IF;
 -- A commitment closes once, and nothing else about it changes.
 IF OLD.state<>'committed' OR NEW.job_id<>OLD.job_id OR NEW.attempt<>OLD.attempt
    OR NEW.estimated_points<>OLD.estimated_points OR NEW.state='committed' THEN
  RAISE EXCEPTION 'AI spending commitment is closed';
 END IF;
 -- An overrun may take the counter past the ceiling; that closes it to new claims.
 UPDATE ai_test_spending_ceiling SET committed_points=committed_points
  - OLD.estimated_points + CASE WHEN NEW.state='settled' THEN NEW.actual_points ELSE 0 END
  WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI test spending ceiling unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_spending_commitment_guard ON ai_spending_commitments;
CREATE TRIGGER ai_spending_commitment_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_spending_commitments
 FOR EACH ROW EXECUTE FUNCTION guard_ai_spending_commitment();
INSERT INTO schema_migrations(version) VALUES(115) ON CONFLICT DO NOTHING;
COMMIT;
