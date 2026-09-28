BEGIN;
-- One principal cannot commit to overlapping non-retired sample slots in
-- either role, across all domains/services. Half-open intervals allow adjacency.
-- The excluded row permits preview/hold validation of already persisted slots.
CREATE OR REPLACE FUNCTION sample_slot_conflicts(
 p_primary uuid,p_backup uuid,p_start timestamptz,p_end timestamptz,p_exclude uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
   SELECT 1 FROM expert_availability_slots s
   JOIN expert_registry e ON e.id=s.expert_registry_id
   WHERE s.retired_at IS NULL AND s.id IS DISTINCT FROM p_exclude
     AND (e.staff_id IN (p_primary,p_backup)
       OR e.backup_staff_id IN (p_primary,p_backup))
     AND tstzrange(s.starts_at,s.ends_at,'[)') && tstzrange(p_start,p_end,'[)')
 );
$$;

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

INSERT INTO schema_migrations(version) VALUES(37) ON CONFLICT DO NOTHING;
COMMIT;
