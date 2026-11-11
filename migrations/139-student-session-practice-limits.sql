-- #823 owner decision of 11 November 2026: an administrator sets each student's
-- session length and practice-conversation limit in the coaching terms. Until
-- then every session hold was 60 minutes and every practice conversation ended
-- at 15 exchanges; those stay the values for terms that don't say otherwise and
-- for students with no terms.
--
-- A session is 15 to 60 minutes: an expert's time slot is one hour (027). A
-- practice conversation has 1 to 50 exchanges. A hold keeps the minutes it
-- reserved and a conversation keeps the limit it started with, so new terms
-- apply to new holds and new conversations only.
BEGIN;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=139) THEN
 ALTER TABLE coaching_terms
   ADD COLUMN session_minutes integer NOT NULL DEFAULT 60
     CHECK(session_minutes BETWEEN 15 AND 60),
   ADD COLUMN practice_exchanges integer NOT NULL DEFAULT 15
     CHECK(practice_exchanges BETWEEN 1 AND 50);
 ALTER TABLE private_practice_sessions
   ADD COLUMN exchange_limit integer NOT NULL DEFAULT 15
     CHECK(exchange_limit BETWEEN 1 AND 50);
 ALTER TABLE private_practice_exchanges
   DROP CONSTRAINT private_practice_exchanges_sequence_check,
   ADD CONSTRAINT private_practice_exchanges_sequence_check
     CHECK(sequence BETWEEN 1 AND 50);
 INSERT INTO schema_migrations(version) VALUES(139);
END IF;
END $$;

-- The student's current values, or the defaults when no terms are set.
CREATE OR REPLACE FUNCTION student_session_minutes(p_member uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT session_minutes FROM coaching_terms
   WHERE owner_id=p_member ORDER BY version DESC LIMIT 1),60);
$$;
CREATE OR REPLACE FUNCTION student_practice_exchanges(p_member uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT practice_exchanges FROM coaching_terms
   WHERE owner_id=p_member ORDER BY version DESC LIMIT 1),15);
$$;

-- A conversation never grows past the limit it started with.
CREATE OR REPLACE FUNCTION hold_practice_exchange_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.sequence>(SELECT exchange_limit FROM private_practice_sessions WHERE id=NEW.session_id) THEN
  RAISE EXCEPTION USING ERRCODE='check_violation', MESSAGE='Practice conversation limit reached';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_practice_exchanges_limit ON private_practice_exchanges;
CREATE TRIGGER private_practice_exchanges_limit BEFORE INSERT ON private_practice_exchanges
 FOR EACH ROW EXECUTE FUNCTION hold_practice_exchange_limit();

-- 037's hold, reserving the student's session length instead of a fixed 60.
-- The two COUNT(*)*60 terms are expert slot capacity: a slot is still one hour.
CREATE OR REPLACE FUNCTION synthetic_hold_slot(
 p_member uuid,p_slot uuid,p_grant uuid,p_key text,p_fingerprint text,
 p_deadline timestamptz,p_now timestamptz
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_previous record;
 v_slot record;
 v_grant record;
 v_hold uuid := gen_random_uuid();
 v_reservation uuid := gen_random_uuid();
 v_minutes integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key,0));
 SELECT request_fingerprint,result_id INTO v_previous
 FROM synthetic_entitlement_events WHERE idempotency_key=p_key;
 IF FOUND THEN
   IF v_previous.request_fingerprint<>p_fingerprint THEN
     RAISE EXCEPTION USING ERRCODE='DN005', MESSAGE='Synthetic hold idempotency conflict';
   END IF;
   RETURN v_previous.result_id;
 END IF;

 SELECT s.id,s.starts_at,e.service_type INTO v_slot
 FROM expert_availability_slots s
 JOIN expert_registry e ON e.id=s.expert_registry_id
 JOIN principals primary_staff ON primary_staff.id=e.staff_id
 JOIN expert_registry b ON b.staff_id=e.backup_staff_id
   AND b.domain=e.domain AND b.service_type=e.service_type
 JOIN principals backup_staff ON backup_staff.id=b.staff_id
 WHERE s.id=p_slot AND s.retired_at IS NULL AND s.starts_at>p_now
   AND NOT sample_slot_conflicts(e.staff_id,e.backup_staff_id,
     s.starts_at,s.ends_at,s.id)
   AND e.retired_at IS NULL AND e.verified_by IS NOT NULL
   AND e.verified_at IS NOT NULL AND e.verified_at<=p_now
   AND e.qualification_ref<>'' AND e.agreement_ref<>'' AND e.conflict_review_ref<>''
   AND e.starts_at<=p_now AND e.starts_at<=s.starts_at AND e.ends_at>=s.ends_at
   AND primary_staff.kind='staff' AND primary_staff.revoked_at IS NULL
   AND primary_staff.expires_at>p_now
   AND b.retired_at IS NULL AND b.verified_by IS NOT NULL
   AND b.verified_at IS NOT NULL AND b.verified_at<=p_now
   AND b.qualification_ref<>'' AND b.agreement_ref<>'' AND b.conflict_review_ref<>''
   AND b.starts_at<=p_now AND b.starts_at<=s.starts_at AND b.ends_at>=s.ends_at
   AND backup_staff.kind='staff' AND backup_staff.revoked_at IS NULL
   AND backup_staff.expires_at>p_now
   AND e.capacity_minutes-e.committed_minutes >= (
     SELECT COUNT(*)*60 FROM expert_availability_slots counted
     WHERE counted.expert_registry_id=e.id AND counted.retired_at IS NULL
       AND counted.starts_at>p_now
   )
   AND b.capacity_minutes-b.committed_minutes >= (
     SELECT COUNT(*)*60 FROM expert_availability_slots counted
     JOIN expert_registry source ON source.id=counted.expert_registry_id
     WHERE source.backup_staff_id=b.staff_id AND source.domain=b.domain
       AND source.service_type=b.service_type AND counted.retired_at IS NULL
       AND counted.starts_at>p_now
   )
 ORDER BY b.id LIMIT 1 FOR UPDATE OF s,e,b,primary_staff,backup_staff;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Synthetic slot unavailable';
 END IF;
 IF p_deadline<=p_now OR p_deadline>v_slot.starts_at THEN
   RAISE EXCEPTION USING ERRCODE='DN001', MESSAGE='Invalid synthetic hold deadline';
 END IF;
 IF EXISTS(SELECT 1 FROM synthetic_slot_holds WHERE slot_id=p_slot AND state='held') THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Synthetic slot unavailable';
 END IF;

 SELECT g.id,g.available INTO v_grant
 FROM synthetic_entitlement_grants g
 JOIN principals member ON member.id=g.member_id
 WHERE g.id=p_grant AND g.member_id=p_member
   AND member.kind='member' AND member.revoked_at IS NULL
   AND member.expires_at>p_now
   AND g.starts_at<=p_now AND g.expires_at>p_now AND g.expired_at IS NULL
   AND g.category=CASE v_slot.service_type
     WHEN 'coaching' THEN 'coach_minutes' ELSE 'review_minutes' END
 FOR UPDATE OF g,member;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Synthetic grant unavailable';
 END IF;
 v_minutes := student_session_minutes(p_member);
 IF v_grant.available<v_minutes THEN
   RAISE EXCEPTION USING ERRCODE='DN003', MESSAGE='Insufficient synthetic minutes';
 END IF;

 UPDATE synthetic_entitlement_grants SET available=available-v_minutes,reserved=reserved+v_minutes
 WHERE id=p_grant;
 INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state)
 VALUES(v_reservation,p_grant,v_minutes,'reserved');
 INSERT INTO synthetic_slot_holds
   (id,slot_id,member_id,grant_id,reservation_id,state,expires_at)
 VALUES(v_hold,p_slot,p_member,p_grant,v_reservation,'held',p_deadline);
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,
    idempotency_key,request_fingerprint,result_id)
 VALUES(gen_random_uuid(),p_member,p_grant,v_reservation,'reserve',v_minutes,
        p_key,p_fingerprint,v_hold);
 RETURN v_hold;
END $$;

-- 028's expiry, 046's withdrawal and 128's staff cancellation, each returning
-- the minutes that hold reserved instead of a fixed 60.
CREATE OR REPLACE FUNCTION synthetic_expire_slot_hold(
 p_hold uuid,p_key text,p_fingerprint text,p_now timestamptz
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_previous record;
 v_slot uuid;
 v_hold record;
 v_grant_current boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key,0));
 SELECT request_fingerprint,result_id INTO v_previous
 FROM synthetic_entitlement_events WHERE idempotency_key=p_key;
 IF FOUND THEN
   IF v_previous.request_fingerprint<>p_fingerprint THEN
     RAISE EXCEPTION USING ERRCODE='DN005', MESSAGE='Synthetic hold idempotency conflict';
   END IF;
   RETURN v_previous.result_id;
 END IF;
 SELECT slot_id INTO v_slot FROM synthetic_slot_holds WHERE id=p_hold;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Synthetic hold unavailable';
 END IF;
 PERFORM 1 FROM expert_availability_slots WHERE id=v_slot FOR UPDATE;
 SELECT h.member_id,h.grant_id,h.reservation_id,h.expires_at,h.state,
        r.state AS reservation_state,r.quantity AS reservation_quantity,
        g.expires_at AS grant_expires_at,g.expired_at AS grant_expired_at,
        member.revoked_at AS member_revoked_at,
        member.expires_at AS member_expires_at
 INTO v_hold
 FROM synthetic_slot_holds h
 JOIN synthetic_entitlement_reservations r ON r.id=h.reservation_id
 JOIN synthetic_entitlement_grants g ON g.id=h.grant_id
 JOIN principals member ON member.id=h.member_id
 WHERE h.id=p_hold FOR UPDATE OF h,r,g,member;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Synthetic hold unavailable';
 END IF;
 IF v_hold.state<>'held' OR v_hold.reservation_state<>'reserved' THEN
   RAISE EXCEPTION USING ERRCODE='DN004', MESSAGE='Synthetic hold already settled';
 END IF;
 IF p_now<v_hold.expires_at THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Synthetic hold not yet due';
 END IF;
 v_grant_current := v_hold.grant_expired_at IS NULL
   AND p_now<v_hold.grant_expires_at
   AND v_hold.member_revoked_at IS NULL
   AND p_now<v_hold.member_expires_at;
 IF v_grant_current THEN
   UPDATE synthetic_entitlement_grants
   SET reserved=reserved-v_hold.reservation_quantity,available=available+v_hold.reservation_quantity WHERE id=v_hold.grant_id;
 ELSE
   UPDATE synthetic_entitlement_grants
   SET reserved=reserved-v_hold.reservation_quantity,expired=expired+v_hold.reservation_quantity WHERE id=v_hold.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released'
 WHERE id=v_hold.reservation_id;
 UPDATE synthetic_slot_holds SET state='expired',expired_at=p_now WHERE id=p_hold;
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,
    idempotency_key,request_fingerprint,result_id)
 VALUES(gen_random_uuid(),v_hold.member_id,v_hold.grant_id,v_hold.reservation_id,
        'release',v_hold.reservation_quantity,p_key,p_fingerprint,p_hold);
 RETURN p_hold;
END $$;

CREATE OR REPLACE FUNCTION withdraw_member_sample_hold(p_token text,p_request uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_receipt record;
 v_hold record;
 v_now timestamptz;
 v_key text;
 v_expiry_key text;
BEGIN
 SELECT r.member_id,r.hold_id,r.slot_id INTO v_receipt
 FROM synthetic_member_hold_receipts r JOIN principals p ON p.id=r.member_id
 WHERE r.request_id=p_request AND p.token_hash=p_token AND p.kind='member'
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp();
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample withdrawal unavailable';
 END IF;
 -- Share expiry's advisory lock, then its slot and settlement row lock order.
 -- No member lock is retained while waiting for the slot.
 v_expiry_key := 'sample-expire:' || v_receipt.hold_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_expiry_key,0));
 PERFORM 1 FROM expert_availability_slots WHERE id=v_receipt.slot_id FOR UPDATE;
 SELECT h.*,r.state AS reservation_state,r.quantity AS reservation_quantity,
        g.category,g.expires_at AS grant_expires_at,g.expired_at AS grant_expired_at,
        member.token_hash,member.kind,member.revoked_at,member.expires_at AS member_expires_at
 INTO v_hold
 FROM synthetic_slot_holds h
 JOIN synthetic_entitlement_reservations r ON r.id=h.reservation_id AND r.grant_id=h.grant_id
 JOIN synthetic_entitlement_grants g ON g.id=h.grant_id AND g.member_id=h.member_id
 JOIN principals member ON member.id=h.member_id
 JOIN synthetic_member_hold_receipts receipt ON receipt.hold_id=h.id
   AND receipt.member_id=h.member_id AND receipt.slot_id=h.slot_id AND receipt.grant_id=h.grant_id
 WHERE h.id=v_receipt.hold_id AND h.member_id=v_receipt.member_id
   AND g.category=CASE receipt.service_type WHEN 'coaching' THEN 'coach_minutes' ELSE 'review_minutes' END
 FOR UPDATE OF h,r,g,member;
 -- Read wall time and validate the token again after all potentially blocking locks.
 v_now := clock_timestamp();
 IF NOT FOUND OR v_hold.token_hash<>p_token OR v_hold.kind<>'member'
   OR v_hold.revoked_at IS NOT NULL OR v_hold.member_expires_at<=v_now THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample withdrawal unavailable';
 END IF;
 IF v_hold.state IN ('released','expired') THEN RETURN p_request; END IF;
 IF v_hold.reservation_state<>'reserved' THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample withdrawal unavailable';
 END IF;
 IF v_hold.expires_at<=v_now THEN
   -- Deadline expiry wins. Report the actual expired receipt, never withdrawal success.
   PERFORM synthetic_expire_slot_hold(v_hold.id,v_expiry_key,
     encode(sha256(v_expiry_key::bytea),'hex'),v_now);
   RETURN p_request;
 END IF;
 IF v_hold.grant_expired_at IS NULL AND v_hold.grant_expires_at>v_now THEN
   UPDATE synthetic_entitlement_grants SET reserved=reserved-v_hold.reservation_quantity,available=available+v_hold.reservation_quantity
   WHERE id=v_hold.grant_id;
 ELSE
   UPDATE synthetic_entitlement_grants SET reserved=reserved-v_hold.reservation_quantity,expired=expired+v_hold.reservation_quantity
   WHERE id=v_hold.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=v_hold.reservation_id;
 UPDATE synthetic_slot_holds SET state='released',released_at=v_now WHERE id=v_hold.id;
 v_key := 'sample-withdraw:' || v_hold.id;
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
 VALUES(gen_random_uuid(),v_hold.member_id,v_hold.grant_id,v_hold.reservation_id,
        'release',v_hold.reservation_quantity,v_key,encode(sha256(v_key::bytea),'hex'),v_hold.id);
 RETURN p_request;
END $$;

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
   OR v_hold.expires_at<=v_now THEN
   -- Withdrawn, expired, cancelled or past its deadline: the form is stale.
   RAISE EXCEPTION USING ERRCODE='DN004', MESSAGE='Sample hold already settled';
 END IF;
 IF v_hold.grant_expired_at IS NOT NULL OR v_hold.grant_expires_at<=v_now
   OR v_hold.member_revoked_at IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='DN006', MESSAGE='Credit period ended';
 END IF;

 -- Original credit: the reserved minutes are released and moved, by an
 -- adjustment, to the replacement; its counters never return them twice.
 UPDATE synthetic_entitlement_grants SET reserved=reserved-v_hold.reservation_quantity,adjusted=adjusted+v_hold.reservation_quantity
 WHERE id=v_hold.grant_id;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=v_hold.reservation_id;
 UPDATE synthetic_slot_holds SET state='cancelled',cancelled_at=v_now WHERE id=p_hold;
 INSERT INTO synthetic_entitlement_grants
   (id,member_id,category,quantity,available,starts_at,expires_at)
 VALUES(v_replacement,v_hold.member_id,v_hold.category,v_hold.reservation_quantity,v_hold.reservation_quantity,
        v_hold.grant_starts_at,v_hold.grant_expires_at);
 v_key := 'sample-staff-cancel:' || p_hold;
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
 VALUES
   (gen_random_uuid(),v_hold.member_id,v_hold.grant_id,v_hold.reservation_id,'release',v_hold.reservation_quantity,
    v_key || ':release',encode(sha256((v_key || ':release')::bytea),'hex'),v_hold.reservation_id),
   (gen_random_uuid(),v_hold.member_id,v_hold.grant_id,NULL,'adjust',v_hold.reservation_quantity,
    v_key || ':adjust',encode(sha256((v_key || ':adjust')::bytea),'hex'),v_hold.grant_id),
   (gen_random_uuid(),v_hold.member_id,v_replacement,NULL,'grant',v_hold.reservation_quantity,
    v_key || ':grant',encode(sha256((v_key || ':grant')::bytea),'hex'),v_replacement);
 INSERT INTO sample_hold_staff_cancellations
   (id,request_id,hold_id,member_id,staff_id,reason,original_grant_id,replacement_grant_id,cancelled_at)
 VALUES(v_id,p_request,p_hold,v_hold.member_id,v_staff,p_reason,v_hold.grant_id,v_replacement,v_now);
 cancellation_id := v_id;
 replayed := false;
END $$;
COMMIT;
