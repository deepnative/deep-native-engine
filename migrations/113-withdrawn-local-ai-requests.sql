BEGIN;
-- #744 A never-started request closed because its permission ended (withdrawn,
-- retired by a new version or removed with its source) was recorded with the
-- same reason as a provider failure, so it read as failed. It now keeps its own
-- reason. Started requests still stay held with an unknown outcome (#735).
ALTER TABLE adapter_jobs
 DROP CONSTRAINT adapter_jobs_safe_error_check,
 ADD CONSTRAINT adapter_jobs_safe_error_check
  CHECK(safe_error IN ('provider_unavailable','provider_timeout','invalid_provider_response','provider_outcome_unknown','permission_withdrawn'));
CREATE OR REPLACE FUNCTION retire_parent_local_ai_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision_parent_id IS NOT NULL THEN
  UPDATE local_ai_receipts SET withdrawn_at=clock_timestamp()
   WHERE evidence_id=NEW.revision_parent_id AND withdrawn_at IS NULL;
  UPDATE adapter_jobs SET
   status=CASE WHEN attempt_count>0 THEN 'needs_reconciliation' ELSE 'exhausted' END,
   safe_error=CASE WHEN attempt_count>0 THEN 'provider_outcome_unknown' ELSE 'permission_withdrawn' END,
   attempt_token=NULL,lease_until=NULL,provider_operation_reference=NULL,updated_at=clock_timestamp()
   WHERE local_ai_receipt_id IN (
     SELECT id FROM local_ai_receipts WHERE evidence_id=NEW.revision_parent_id
   ) AND status IN ('pending','failed','running');
 END IF;
 RETURN NEW;
END $$;
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
    UPDATE adapter_jobs SET status='exhausted',attempt_token=NULL,lease_until=NULL,safe_error='permission_withdrawn',updated_at=clock_timestamp() WHERE id=item.id;
   ELSIF item.state='reserved' AND item.attempt_count>0 AND item.status<>'needs_reconciliation' THEN
    UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown',provider_operation_reference=NULL,updated_at=clock_timestamp() WHERE id=item.id;
   END IF;
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN
  UPDATE adapter_jobs j SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown',provider_operation_reference=NULL,updated_at=clock_timestamp()
   WHERE j.local_ai_receipt_id=OLD.id AND j.attempt_count>0 AND j.status IN ('running','failed')
    AND NOT EXISTS(SELECT 1 FROM local_ai_test_unit_jobs b WHERE b.job_id=j.id);
  DELETE FROM adapter_jobs j WHERE j.local_ai_receipt_id=OLD.id AND j.status<>'needs_reconciliation'
   AND NOT EXISTS(SELECT 1 FROM local_ai_test_unit_jobs b WHERE b.job_id=j.id)
   AND NOT EXISTS(SELECT 1 FROM local_ai_hold_inspection_grants g WHERE g.job_id=j.id);
  RETURN OLD;
 END IF;
 RETURN NEW;
END $$;
-- Earlier cancellations: a request that never started can only have been
-- closed by its permission ending, because every provider attempt counts first.
UPDATE adapter_jobs j SET safe_error='permission_withdrawn'
 WHERE j.status='exhausted' AND j.attempt_count=0 AND j.safe_error='provider_unavailable'
  AND EXISTS(SELECT 1 FROM local_ai_receipts p WHERE p.id=j.local_ai_receipt_id AND p.withdrawn_at IS NOT NULL);
INSERT INTO schema_migrations(version) VALUES(113) ON CONFLICT DO NOTHING;
COMMIT;
