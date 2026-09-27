BEGIN;
CREATE TABLE IF NOT EXISTS synthetic_slot_holds (
 id uuid PRIMARY KEY,
 slot_id uuid NOT NULL REFERENCES expert_availability_slots(id) ON DELETE RESTRICT,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 grant_id uuid NOT NULL REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 reservation_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_reservations(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('held','expired')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expired_at timestamptz,
 CHECK((state='held' AND expired_at IS NULL) OR
       (state='expired' AND expired_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS synthetic_slot_one_active_hold
 ON synthetic_slot_holds(slot_id) WHERE state='held';

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
 IF v_grant.available<60 THEN
   RAISE EXCEPTION USING ERRCODE='DN003', MESSAGE='Insufficient synthetic minutes';
 END IF;

 UPDATE synthetic_entitlement_grants SET available=available-60,reserved=reserved+60
 WHERE id=p_grant;
 INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state)
 VALUES(v_reservation,p_grant,60,'reserved');
 INSERT INTO synthetic_slot_holds
   (id,slot_id,member_id,grant_id,reservation_id,state,expires_at)
 VALUES(v_hold,p_slot,p_member,p_grant,v_reservation,'held',p_deadline);
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,
    idempotency_key,request_fingerprint,result_id)
 VALUES(gen_random_uuid(),p_member,p_grant,v_reservation,'reserve',60,
        p_key,p_fingerprint,v_hold);
 RETURN v_hold;
END $$;

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
        r.state AS reservation_state,
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
   SET reserved=reserved-60,available=available+60 WHERE id=v_hold.grant_id;
 ELSE
   UPDATE synthetic_entitlement_grants
   SET reserved=reserved-60,expired=expired+60 WHERE id=v_hold.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released'
 WHERE id=v_hold.reservation_id;
 UPDATE synthetic_slot_holds SET state='expired',expired_at=p_now WHERE id=p_hold;
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,
    idempotency_key,request_fingerprint,result_id)
 VALUES(gen_random_uuid(),v_hold.member_id,v_hold.grant_id,v_hold.reservation_id,
        'release',60,p_key,p_fingerprint,p_hold);
 RETURN p_hold;
END $$;

INSERT INTO schema_migrations(version) VALUES(28) ON CONFLICT DO NOTHING;
COMMIT;
