BEGIN;
-- One reviewed, labelled TEST outcome for a held invented local AI request
-- (#189). Fixed codes and a test reference only: never prompt, source, provider
-- text or free-form notes. It is not provider confirmation, and it does not
-- charge, refund, release a unit or retry. Account erasure still removes it.
CREATE TABLE IF NOT EXISTS local_ai_hold_test_decisions (
 job_id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 grant_id uuid NOT NULL,
 operator_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 outcome text NOT NULL CHECK(outcome IN ('test-executed','test-not-executed')),
 reason text NOT NULL CHECK(reason IN ('matching-test-record','operator-test-exercise')),
 source_kind text NOT NULL DEFAULT 'invented-test-record' CHECK(source_kind='invented-test-record'),
 source_reference text NOT NULL CHECK(source_reference ~ '^test-[a-z0-9-]{1,60}$'),
 prior_status text NOT NULL CHECK(prior_status IN ('needs_reconciliation','expired-claim')),
 idempotency_key uuid NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(job_id,member_id) REFERENCES adapter_jobs(id,member_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS local_ai_hold_test_decisions_key
 ON local_ai_hold_test_decisions(operator_id,idempotency_key);
CREATE INDEX IF NOT EXISTS local_ai_hold_test_decisions_member_idx
 ON local_ai_hold_test_decisions(member_id,job_id);

-- A decision is written once by an operator holding a current exact assignment
-- to a request that is still held. Afterwards only erasure can touch it.
CREATE OR REPLACE FUNCTION guard_local_ai_hold_test_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id)
  THEN RAISE EXCEPTION 'A reviewed hold decision requires member erasure'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'operator_id') IS DISTINCT FROM (to_jsonb(OLD)-'operator_id')
   OR NOT (NEW.operator_id IS NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.operator_id))
  THEN RAISE EXCEPTION 'A reviewed hold decision is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM adapter_jobs j
  JOIN local_ai_hold_inspection_grants g ON g.job_id=j.id AND g.member_id=j.member_id
  JOIN principals p ON p.id=g.staff_id
  JOIN staff_profiles s ON s.principal_id=p.id
  LEFT JOIN local_ai_test_unit_jobs b ON b.job_id=j.id
  LEFT JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
  WHERE j.id=NEW.job_id AND j.member_id=NEW.member_id AND j.adapter='ai'
   AND j.mode IN ('demo','test') AND j.status='needs_reconciliation'
   AND (b.job_id IS NULL OR r.state='reserved')
   AND g.id=NEW.grant_id AND g.staff_id=NEW.operator_id AND g.revoked_at IS NULL
   AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
   AND p.kind='staff' AND s.role='operator' AND p.revoked_at IS NULL
   AND p.expires_at>clock_timestamp()
 ) THEN RAISE EXCEPTION 'Hold decision authority unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_ai_hold_test_decision_guard ON local_ai_hold_test_decisions;
CREATE TRIGGER local_ai_hold_test_decision_guard BEFORE INSERT OR UPDATE OR DELETE
 ON local_ai_hold_test_decisions FOR EACH ROW EXECUTE FUNCTION guard_local_ai_hold_test_decision();

-- A late worker, sweep or future callback cannot move a reviewed job. Other
-- columns, such as a cleared source reference, may still change.
CREATE OR REPLACE FUNCTION freeze_reviewed_local_ai_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.status,NEW.attempt_count,NEW.attempt_token,NEW.lease_until,NEW.safe_error,NEW.provider_operation_reference)
    IS DISTINCT FROM
    (OLD.status,OLD.attempt_count,OLD.attempt_token,OLD.lease_until,OLD.safe_error,OLD.provider_operation_reference)
  AND EXISTS(SELECT 1 FROM local_ai_hold_test_decisions WHERE job_id=OLD.id)
 THEN RAISE EXCEPTION 'A reviewed local AI hold cannot change'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS freeze_reviewed_local_ai_job ON adapter_jobs;
CREATE TRIGGER freeze_reviewed_local_ai_job BEFORE UPDATE ON adapter_jobs
 FOR EACH ROW EXECUTE FUNCTION freeze_reviewed_local_ai_job();
INSERT INTO schema_migrations(version) VALUES(111) ON CONFLICT DO NOTHING;
COMMIT;
