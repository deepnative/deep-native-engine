BEGIN;
-- #188/#200 Simulated practice suggestions count against the platform test
-- spending ceiling like metered sample requests. A practice request takes no
-- member unit, so its estimate, commitment and settlement are admitted for
-- its own single running attempt instead: the estimate only while its
-- suggestion is still requested and before any commitment, the commitment at
-- that stored estimate, and the settlement only while that commitment is
-- open. A pair withdrawn during the call still settles what was spent.
-- Everything else about migrations 100 and 116 is unchanged.
CREATE OR REPLACE FUNCTION practice_ai_request_open(job uuid, member uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM adapter_jobs j
  WHERE j.id=job AND j.member_id=member AND j.adapter='ai' AND j.mode IN ('demo','test')
   AND j.operation='practice-suggestion-local-v1' AND j.local_ai_receipt_id IS NULL
   AND j.status='running' AND j.attempt_count=1 AND j.max_attempts=1
   AND NOT EXISTS(SELECT 1 FROM local_ai_test_unit_jobs b WHERE b.job_id=j.id))
$$;

CREATE OR REPLACE FUNCTION guard_ai_usage_estimate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM adapter_jobs j JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
  WHERE j.id=NEW.job_id AND j.member_id=NEW.member_id AND j.status='pending' AND j.attempt_count=0
 ) AND NOT (practice_ai_request_open(NEW.job_id,NEW.member_id)
  AND EXISTS(SELECT 1 FROM practice_ai_suggestions g
   WHERE g.job_id=NEW.job_id AND g.member_id=NEW.member_id AND g.state='requested')
  AND NOT EXISTS(SELECT 1 FROM ai_spending_commitments c WHERE c.job_id=NEW.job_id))
 THEN RAISE EXCEPTION 'AI usage estimate needs a new metered request'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_ai_usage_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM adapter_jobs j
  JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
  JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
  WHERE j.id=NEW.job_id AND j.member_id=NEW.member_id AND j.status='running' AND j.attempt_count=1
   AND r.state='consumed'
 ) AND NOT (practice_ai_request_open(NEW.job_id,NEW.member_id)
  AND EXISTS(SELECT 1 FROM ai_spending_commitments c
   WHERE c.job_id=NEW.job_id AND c.attempt=1 AND c.state='committed'))
 THEN RAISE EXCEPTION 'AI usage settlement is out of order'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_ai_spending_commitment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  -- Only a fresh dispatch claim of a metered request, at its stored estimate.
  IF NEW.state<>'committed' OR NEW.actual_points IS NOT NULL OR NOT (EXISTS(
   SELECT 1 FROM adapter_jobs j
   JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
   JOIN ai_usage_estimates e ON e.job_id=j.id AND e.member_id=j.member_id
   WHERE j.id=NEW.job_id AND j.status='running' AND j.attempt_count=NEW.attempt
    AND e.cost_points=NEW.estimated_points
  ) OR (NEW.attempt=1 AND EXISTS(
   SELECT 1 FROM ai_usage_estimates e
   WHERE e.job_id=NEW.job_id AND e.cost_points=NEW.estimated_points
    AND practice_ai_request_open(e.job_id,e.member_id)
  ))) THEN RAISE EXCEPTION 'AI spending commitment needs a claimed metered request'; END IF;
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
INSERT INTO schema_migrations(version) VALUES(123) ON CONFLICT DO NOTHING;
COMMIT;
