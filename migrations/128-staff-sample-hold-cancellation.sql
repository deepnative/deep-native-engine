BEGIN;
-- #27 STAFFCANCEL (F-BUILD-03-C): an operator may cancel a member's held sample
-- slot. The cancellation is appended, never written over: the original credit
-- keeps its grant and reserve events and gains a release and an adjustment,
-- and exactly one replacement credit is granted with the replaced credit's own
-- start and expiry ("correctly dated"). Test minutes only; no booking, payment,
-- refund or commercial cancellation term.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=128) THEN
 ALTER TABLE synthetic_slot_holds ADD COLUMN cancelled_at timestamptz;
 ALTER TABLE synthetic_slot_holds
   DROP CONSTRAINT synthetic_slot_holds_state_check,
   ADD CONSTRAINT synthetic_slot_holds_state_check
     CHECK(state IN ('held','expired','released','cancelled')),
   DROP CONSTRAINT synthetic_slot_holds_check,
   ADD CONSTRAINT synthetic_slot_holds_check CHECK(
     (state='held' AND expired_at IS NULL AND released_at IS NULL AND cancelled_at IS NULL) OR
     (state='expired' AND expired_at IS NOT NULL AND released_at IS NULL AND cancelled_at IS NULL) OR
     (state='released' AND expired_at IS NULL AND released_at IS NOT NULL AND cancelled_at IS NULL) OR
     (state='cancelled' AND expired_at IS NULL AND released_at IS NULL AND cancelled_at IS NOT NULL));
END IF;
END $$;

CREATE TABLE IF NOT EXISTS sample_hold_staff_cancellations (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 hold_id uuid NOT NULL UNIQUE REFERENCES synthetic_slot_holds(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 -- Removing a staff account keeps the record and forgets only who it was.
 staff_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 reason text NOT NULL CHECK(reason IN ('coach-unavailable','scheduling-error','member-request')),
 original_grant_id uuid NOT NULL REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 replacement_grant_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 cancelled_at timestamptz NOT NULL,
 CHECK(original_grant_id<>replacement_grant_id)
);

CREATE OR REPLACE FUNCTION reject_sample_hold_cancellation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
   -- Only the staff account's own removal may clear who cancelled.
   IF NEW.staff_id IS NULL AND OLD.staff_id IS NOT NULL
     AND (to_jsonb(NEW)-'staff_id')=(to_jsonb(OLD)-'staff_id') THEN
     RETURN NEW;
   END IF;
   RAISE EXCEPTION 'Sample hold cancellation history is immutable';
 END IF;
 -- Member removal may cascade-delete the synthetic record; nothing else may.
 IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN
   RAISE EXCEPTION 'Sample hold cancellation history is immutable';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS sample_hold_staff_cancellations_immutable
 ON sample_hold_staff_cancellations;
CREATE TRIGGER sample_hold_staff_cancellations_immutable
 BEFORE UPDATE OR DELETE ON sample_hold_staff_cancellations
 FOR EACH ROW EXECUTE FUNCTION reject_sample_hold_cancellation_mutation();

-- DN002: no current operator, or no such hold (indistinguishable to a caller
-- without authority). DN004: the hold is no longer held (stale form).
-- DN005: this request ID already cancelled something else. DN006: the
-- reserved credit's own period has ended, so it cannot be replaced.
-- Every migration re-runs at each start; 139 (#823) replaces this function so a
-- hold keeps its own minutes, and a restart must not put the fixed 60 back.
DO $guard$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=139) THEN
EXECUTE $create$
CREATE OR REPLACE FUNCTION staff_cancel_sample_hold(
 p_token text,p_hold uuid,p_request uuid,p_reason text,
 OUT cancellation_id uuid,OUT replayed boolean
) LANGUAGE plpgsql AS $$
DECLARE
 v_staff uuid;
 v_previous record;
 v_slot uuid;
 v_hold record;
 v_now timestamptz;
 v_id uuid := gen_random_uuid();
 v_replacement uuid := gen_random_uuid();
 v_key text;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('coach-unavailable','scheduling-error','member-request') THEN
   RAISE EXCEPTION USING ERRCODE='DN001', MESSAGE='Invalid staff cancellation';
 END IF;
 SELECT p.id INTO v_staff FROM principals p
 JOIN authorized_staff_profiles s ON s.principal_id=p.id
 WHERE p.token_hash=p_token AND p.kind='staff' AND s.role IN ('operator','platform_admin')
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp();
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Staff cancellation unavailable';
 END IF;
 -- One request ID is one cancellation: a replay returns it, never a second credit.
 PERFORM pg_advisory_xact_lock(hashtextextended('sample-staff-cancel:' || p_request,0));
 SELECT hold_id,reason,staff_id,id INTO v_previous
 FROM sample_hold_staff_cancellations WHERE request_id=p_request;
 IF FOUND THEN
   IF v_previous.hold_id<>p_hold OR v_previous.reason<>p_reason
     OR v_previous.staff_id IS DISTINCT FROM v_staff THEN
     RAISE EXCEPTION USING ERRCODE='DN005', MESSAGE='Staff cancellation conflict';
   END IF;
   cancellation_id := v_previous.id;
   replayed := true;
   RETURN;
 END IF;
 SELECT slot_id INTO v_slot FROM synthetic_slot_holds WHERE id=p_hold;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Staff cancellation unavailable';
 END IF;
 -- Same advisory key, then slot and settlement row lock order as expiry and
 -- member withdrawal, so the three can only serialize, never interleave.
 PERFORM pg_advisory_xact_lock(hashtextextended('sample-expire:' || p_hold,0));
 PERFORM 1 FROM expert_availability_slots WHERE id=v_slot FOR UPDATE;
 SELECT h.id,h.member_id,h.grant_id,h.reservation_id,h.state,h.expires_at,
        r.state AS reservation_state,r.quantity AS reservation_quantity,
        g.category,g.starts_at AS grant_starts_at,g.expires_at AS grant_expires_at,
        g.expired_at AS grant_expired_at,
        member.kind AS member_kind,member.revoked_at AS member_revoked_at
 INTO v_hold
 FROM synthetic_slot_holds h
 JOIN synthetic_entitlement_reservations r ON r.id=h.reservation_id AND r.grant_id=h.grant_id
 JOIN synthetic_entitlement_grants g ON g.id=h.grant_id AND g.member_id=h.member_id
 JOIN principals member ON member.id=h.member_id
 JOIN synthetic_member_hold_receipts receipt ON receipt.hold_id=h.id
   AND receipt.member_id=h.member_id AND receipt.grant_id=h.grant_id
 WHERE h.id=p_hold
 FOR UPDATE OF h,r,g,member;
 IF NOT FOUND OR v_hold.member_kind<>'member' THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Staff cancellation unavailable';
 END IF;
 -- Read wall time and recheck authority only after every blocking lock.
 v_now := clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM principals p
   JOIN authorized_staff_profiles s ON s.principal_id=p.id
   WHERE p.id=v_staff AND p.token_hash=p_token AND s.role IN ('operator','platform_admin')
     AND p.revoked_at IS NULL AND p.expires_at>v_now) THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Staff cancellation unavailable';
 END IF;
 IF v_hold.state<>'held' OR v_hold.reservation_state<>'reserved'
   OR v_hold.reservation_quantity<>60 OR v_hold.expires_at<=v_now THEN
   -- Withdrawn, expired, cancelled or past its deadline: the form is stale.
   RAISE EXCEPTION USING ERRCODE='DN004', MESSAGE='Sample hold already settled';
 END IF;
 IF v_hold.grant_expired_at IS NOT NULL OR v_hold.grant_expires_at<=v_now
   OR v_hold.member_revoked_at IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='DN006', MESSAGE='Credit period ended';
 END IF;

 -- Original credit: the reserved minutes are released and moved, by an
 -- adjustment, to the replacement; its counters never return them twice.
 UPDATE synthetic_entitlement_grants SET reserved=reserved-60,adjusted=adjusted+60
 WHERE id=v_hold.grant_id;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=v_hold.reservation_id;
 UPDATE synthetic_slot_holds SET state='cancelled',cancelled_at=v_now WHERE id=p_hold;
 INSERT INTO synthetic_entitlement_grants
   (id,member_id,category,quantity,available,starts_at,expires_at)
 VALUES(v_replacement,v_hold.member_id,v_hold.category,60,60,
        v_hold.grant_starts_at,v_hold.grant_expires_at);
 v_key := 'sample-staff-cancel:' || p_hold;
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
 VALUES
   (gen_random_uuid(),v_hold.member_id,v_hold.grant_id,v_hold.reservation_id,'release',60,
    v_key || ':release',encode(sha256((v_key || ':release')::bytea),'hex'),v_hold.reservation_id),
   (gen_random_uuid(),v_hold.member_id,v_hold.grant_id,NULL,'adjust',60,
    v_key || ':adjust',encode(sha256((v_key || ':adjust')::bytea),'hex'),v_hold.grant_id),
   (gen_random_uuid(),v_hold.member_id,v_replacement,NULL,'grant',60,
    v_key || ':grant',encode(sha256((v_key || ':grant')::bytea),'hex'),v_replacement);
 INSERT INTO sample_hold_staff_cancellations
   (id,request_id,hold_id,member_id,staff_id,reason,original_grant_id,replacement_grant_id,cancelled_at)
 VALUES(v_id,p_request,p_hold,v_hold.member_id,v_staff,p_reason,v_hold.grant_id,v_replacement,v_now);
 cancellation_id := v_id;
 replayed := false;
END $$
$create$;
END IF;
END $guard$;
INSERT INTO schema_migrations(version) VALUES(128) ON CONFLICT DO NOTHING;
COMMIT;
