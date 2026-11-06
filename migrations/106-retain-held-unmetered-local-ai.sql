BEGIN;
-- Hold inspection can now name an unmetered held request, so grants and their
-- audit events link to the owned job itself instead of its test-unit link.
ALTER TABLE local_ai_hold_inspection_grants
 DROP CONSTRAINT IF EXISTS local_ai_hold_inspection_grants_job_id_member_id_fkey,
 ADD CONSTRAINT local_ai_hold_inspection_grants_job_id_member_id_fkey
  FOREIGN KEY(job_id,member_id) REFERENCES adapter_jobs(id,member_id) ON DELETE CASCADE;
ALTER TABLE local_ai_hold_inspection_events
 DROP CONSTRAINT IF EXISTS local_ai_hold_inspection_events_job_id_member_id_fkey,
 ADD CONSTRAINT local_ai_hold_inspection_events_job_id_member_id_fkey
  FOREIGN KEY(job_id,member_id) REFERENCES adapter_jobs(id,member_id) ON DELETE CASCADE;
-- Deleting a source removes its text and permission but not the record that a
-- started request may have left the system. The receipt reference clears through
-- its foreign key; full member erasure still cascades every row. A job with an
-- inspection grant also stays, so its audit trail can never block a deletion.
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
INSERT INTO schema_migrations(version) VALUES(106) ON CONFLICT DO NOTHING;
COMMIT;
