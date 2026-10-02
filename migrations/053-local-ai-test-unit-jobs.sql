BEGIN;
-- Explicit deterministic-local test requests only. Legacy jobs receive no link
-- and no charge. A link is retained when its evidence/receipt is removed.
CREATE UNIQUE INDEX IF NOT EXISTS adapter_jobs_id_member_idx ON adapter_jobs(id,member_id);
CREATE TABLE IF NOT EXISTS local_ai_test_unit_jobs (
 job_id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 reservation_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_reservations(id) ON DELETE CASCADE,
 policy text NOT NULL CHECK(policy='deterministic-request-test-v1'),
 FOREIGN KEY(job_id,member_id) REFERENCES adapter_jobs(id,member_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS local_ai_test_unit_jobs_member_idx ON local_ai_test_unit_jobs(member_id,job_id);
CREATE OR REPLACE FUNCTION guard_local_ai_test_unit_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Local test-unit link is immutable'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN
   RAISE EXCEPTION 'Local test-unit history requires member erasure';
  END IF;
  RETURN OLD;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM adapter_jobs j
  JOIN synthetic_entitlement_reservations r ON r.id=NEW.reservation_id
  JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
  WHERE j.id=NEW.job_id AND j.member_id=NEW.member_id AND g.member_id=NEW.member_id
   AND j.adapter='ai' AND j.mode IN ('demo','test') AND j.operation='evidence-summary-local-v1'
   AND j.local_ai_receipt_id IS NOT NULL AND j.status='pending' AND j.attempt_count=0 AND j.max_attempts=1
   AND j.prompt_template_version='local-simulation-v1' AND j.model_contract_version='deterministic-local-v1'
   AND g.category='study_requests' AND r.quantity=1 AND r.state='reserved'
 ) THEN RAISE EXCEPTION 'Invalid local test-unit linkage'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_ai_test_unit_link_guard ON local_ai_test_unit_jobs;
CREATE TRIGGER local_ai_test_unit_link_guard BEFORE INSERT OR UPDATE OR DELETE ON local_ai_test_unit_jobs
 FOR EACH ROW EXECUTE FUNCTION guard_local_ai_test_unit_link();

-- One release-accounting implementation for pool-ledger operations and for
-- cancellation reached through permission/revision/source referential actions.
-- The caller's transaction records its immutable event and terminal job state.
CREATE OR REPLACE FUNCTION release_synthetic_reservation_balance(
 p_reservation uuid,p_member uuid,p_at timestamptz,p_job uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_row record; linked_job uuid;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) THEN RAISE EXCEPTION 'Invalid release time'; END IF;
 SELECT r.grant_id,r.quantity,r.state,g.expires_at,g.expired_at INTO current_row
 FROM synthetic_entitlement_reservations r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
 WHERE r.id=p_reservation AND g.member_id=p_member
 AND NOT EXISTS(SELECT 1 FROM synthetic_slot_holds h WHERE h.reservation_id=r.id)
 FOR UPDATE OF r,g;
 IF NOT FOUND OR current_row.state<>'reserved' THEN RAISE EXCEPTION 'Reservation unavailable'; END IF;
 SELECT job_id INTO linked_job FROM local_ai_test_unit_jobs WHERE reservation_id=p_reservation;
 IF linked_job IS DISTINCT FROM p_job THEN RAISE EXCEPTION 'Reservation belongs to a local job'; END IF;
 IF p_job IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM adapter_jobs WHERE id=p_job AND member_id=p_member AND status='pending' AND attempt_count=0
 ) THEN RAISE EXCEPTION 'Dispatched local request remains held'; END IF;
 IF current_row.expired_at IS NOT NULL OR p_at>=current_row.expires_at THEN
  UPDATE synthetic_entitlement_grants SET reserved=reserved-current_row.quantity,expired=expired+current_row.quantity WHERE id=current_row.grant_id;
 ELSE
  UPDATE synthetic_entitlement_grants SET reserved=reserved-current_row.quantity,available=available+current_row.quantity WHERE id=current_row.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=p_reservation;
END $$;

CREATE OR REPLACE FUNCTION guard_metered_local_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_state text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM local_ai_test_unit_jobs WHERE job_id=OLD.id) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','attempt_count','attempt_token','lease_until','safe_error','provider_operation_reference','updated_at','local_ai_receipt_id'])
  IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['status','attempt_count','attempt_token','lease_until','safe_error','provider_operation_reference','updated_at','local_ai_receipt_id'])
  OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>1 OR NEW.max_attempts<>1
  OR (NEW.local_ai_receipt_id IS DISTINCT FROM OLD.local_ai_receipt_id AND
    (NEW.local_ai_receipt_id IS NOT NULL OR EXISTS(SELECT 1 FROM local_ai_receipts WHERE id=OLD.local_ai_receipt_id)))
 THEN RAISE EXCEPTION 'Local metered job identity/claim is immutable'; END IF;
 IF NEW.attempt_count>0 AND NEW.status IN ('failed','exhausted') THEN
  NEW.status='needs_reconciliation'; NEW.safe_error='provider_outcome_unknown';
  NEW.attempt_token=NULL; NEW.lease_until=NULL; NEW.provider_operation_reference=NULL;
 END IF;
 IF (OLD.status IN ('succeeded','needs_reconciliation','exhausted') AND NEW.status<>OLD.status)
   OR (OLD.attempt_count>0 AND NEW.status='pending') THEN
  RAISE EXCEPTION 'Local metered outcome cannot be replayed';
 END IF;
 SELECT r.state INTO reservation_state FROM local_ai_test_unit_jobs b
 JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id WHERE b.job_id=OLD.id;
 IF NOT (
  (NEW.status='pending' AND NEW.attempt_count=0 AND reservation_state='reserved') OR
  (NEW.status='running' AND NEW.attempt_count=1 AND reservation_state='reserved') OR
  (NEW.status='succeeded' AND NEW.attempt_count=1 AND reservation_state='consumed') OR
  (NEW.status='needs_reconciliation' AND NEW.attempt_count=1 AND reservation_state='reserved') OR
  (NEW.status='exhausted' AND NEW.attempt_count=0 AND reservation_state='released')
 ) OR reservation_state IS NULL THEN RAISE EXCEPTION 'Local job and test-unit outcome must agree'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS metered_local_job_guard ON adapter_jobs;
CREATE TRIGGER metered_local_job_guard BEFORE UPDATE ON adapter_jobs FOR EACH ROW EXECUTE FUNCTION guard_metered_local_job();

CREATE OR REPLACE FUNCTION cancel_metered_local_permission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; event_key text; fingerprint text;
BEGIN
 -- Account erasure remains an actual cascade; never append an event for a
 -- removed member or prevent removal of the owned immutable history.
 IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN
  FOR item IN
   SELECT j.id,j.status,j.attempt_count,b.reservation_id,r.grant_id,r.state
   FROM adapter_jobs j JOIN local_ai_test_unit_jobs b ON b.job_id=j.id
   JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
   WHERE j.local_ai_receipt_id=OLD.id AND b.member_id=OLD.member_id
   ORDER BY j.id FOR UPDATE OF j
  LOOP
   IF item.state='reserved' AND item.status='pending' AND item.attempt_count=0 THEN
    PERFORM release_synthetic_reservation_balance(item.reservation_id,OLD.member_id,clock_timestamp(),item.id);
    event_key='local-ai-budget:'||item.id::text||':release';
    fingerprint=encode(sha256(convert_to(format('{"operation":"release","memberId":"%s","reservationId":"%s"}',OLD.member_id,item.reservation_id),'UTF8')),'hex');
    INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
    VALUES(gen_random_uuid(),OLD.member_id,item.grant_id,item.reservation_id,'release',1,event_key,fingerprint,item.reservation_id);
    UPDATE adapter_jobs SET status='exhausted',attempt_token=NULL,lease_until=NULL,safe_error='provider_unavailable',updated_at=clock_timestamp() WHERE id=item.id;
   ELSIF item.state='reserved' AND item.attempt_count>0 AND item.status<>'needs_reconciliation' THEN
    UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown',provider_operation_reference=NULL,updated_at=clock_timestamp() WHERE id=item.id;
   END IF;
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN
  -- Preserve the previous cascade behavior only for legacy unmetered jobs.
  DELETE FROM adapter_jobs j WHERE j.local_ai_receipt_id=OLD.id
   AND NOT EXISTS(SELECT 1 FROM local_ai_test_unit_jobs b WHERE b.job_id=j.id);
  RETURN OLD;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS metered_permission_withdrawal ON local_ai_receipts;
CREATE TRIGGER metered_permission_withdrawal AFTER UPDATE OF withdrawn_at ON local_ai_receipts
 FOR EACH ROW WHEN(OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) EXECUTE FUNCTION cancel_metered_local_permission();
DROP TRIGGER IF EXISTS metered_permission_removal ON local_ai_receipts;
CREATE TRIGGER metered_permission_removal BEFORE DELETE ON local_ai_receipts
 FOR EACH ROW EXECUTE FUNCTION cancel_metered_local_permission();
ALTER TABLE adapter_jobs DROP CONSTRAINT IF EXISTS adapter_jobs_local_ai_receipt_id_fkey;
ALTER TABLE adapter_jobs ADD CONSTRAINT adapter_jobs_local_ai_receipt_id_fkey FOREIGN KEY(local_ai_receipt_id)
 REFERENCES local_ai_receipts(id) ON DELETE SET NULL;
INSERT INTO schema_migrations(version) VALUES(53) ON CONFLICT DO NOTHING;
COMMIT;
