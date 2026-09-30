BEGIN;
CREATE TABLE IF NOT EXISTS synthetic_member_hold_receipts (
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 hold_id uuid NOT NULL UNIQUE REFERENCES synthetic_slot_holds(id) ON DELETE CASCADE,
 slot_id uuid NOT NULL REFERENCES expert_availability_slots(id) ON DELETE RESTRICT,
 grant_id uuid NOT NULL REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 domain text NOT NULL,
 service_type text NOT NULL CHECK(service_type IN ('coaching','formal-review')),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 PRIMARY KEY(member_id,request_id)
);

-- The expiry key is stable across receipt reloads and a new slot contender.
-- Take it before the existing function takes the slot/grant/member locks.
CREATE OR REPLACE FUNCTION settle_due_sample_hold(p_hold uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 v_key text := 'sample-expire:' || p_hold;
 v_slot uuid;
BEGIN
 SELECT slot_id INTO v_slot FROM synthetic_slot_holds
 WHERE id=p_hold AND state='held' AND expires_at<=clock_timestamp();
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
 PERFORM 1 FROM expert_availability_slots WHERE id=v_slot FOR UPDATE;
 PERFORM 1 FROM synthetic_slot_holds h
 JOIN synthetic_entitlement_reservations r ON r.id=h.reservation_id
 JOIN synthetic_entitlement_grants g ON g.id=h.grant_id
 JOIN principals member ON member.id=h.member_id
 WHERE h.id=p_hold AND h.state='held' AND h.expires_at<=clock_timestamp()
 FOR UPDATE OF h,r,g,member;
 IF FOUND THEN
   -- Read wall time only after every potentially blocking settlement lock.
   -- The internal API keeps its explicit deterministic fixture clock.
   PERFORM synthetic_expire_slot_hold(p_hold,v_key,
     encode(sha256(v_key::bytea),'hex'),clock_timestamp());
 END IF;
END $$;

CREATE OR REPLACE FUNCTION settle_member_sample_holds(p_token text,p_request uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_hold uuid;
BEGIN
 FOR v_hold IN
   SELECT h.id FROM synthetic_member_hold_receipts r
   JOIN synthetic_slot_holds h ON h.id=r.hold_id
   JOIN principals p ON p.id=r.member_id
   WHERE p.token_hash=p_token AND p.kind='member'
     AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
     AND r.request_id=p_request
     AND h.state='held' AND h.expires_at<=clock_timestamp()
   ORDER BY h.slot_id,h.id
 LOOP
   PERFORM settle_due_sample_hold(v_hold);
 END LOOP;
END $$;

-- Cleanup is its own committed operation before a new request transaction.
-- It never retains an incumbent member lock while acquiring a new owner's lock.
CREATE OR REPLACE FUNCTION prepare_member_sample_slot(
 p_token text,p_slot uuid,p_request uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_member uuid; v_hold uuid;
BEGIN
 SELECT id INTO v_member FROM principals WHERE token_hash=p_token
   AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp();
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample request unavailable';
 END IF;
 IF EXISTS(SELECT 1 FROM synthetic_member_hold_receipts
   WHERE member_id=v_member AND request_id=p_request) THEN RETURN; END IF;
 SELECT id INTO v_hold FROM synthetic_slot_holds
 WHERE slot_id=p_slot AND state='held' AND expires_at<=clock_timestamp();
 IF FOUND THEN PERFORM settle_due_sample_hold(v_hold); END IF;
END $$;

CREATE OR REPLACE FUNCTION member_sample_hold(
 p_token text,p_slot uuid,p_grant uuid,p_request uuid
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_member uuid;
 v_previous record;
 v_slot record;
 v_hold uuid;
 v_key text;
 v_deadline timestamptz;
BEGIN
 SELECT id INTO v_member FROM principals WHERE token_hash=p_token
   AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp();
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample request unavailable';
 END IF;
 v_key := 'member-sample:' || v_member || ':' || p_request;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
 SELECT * INTO v_previous FROM synthetic_member_hold_receipts
 WHERE member_id=v_member AND request_id=p_request;
 IF FOUND THEN
   IF v_previous.slot_id<>p_slot OR v_previous.grant_id<>p_grant THEN
     RAISE EXCEPTION USING ERRCODE='DN005', MESSAGE='Sample request conflict';
   END IF;
   -- Replays never create a new reservation or recalculate the deadline.
   IF NOT EXISTS(SELECT 1 FROM principals WHERE id=v_member
     AND token_hash=p_token AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN
     RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample request unavailable';
   END IF;
   RETURN p_request;
 END IF;
 SELECT s.starts_at,s.ends_at,e.domain,e.service_type INTO v_slot
 FROM expert_availability_slots s JOIN expert_registry e ON e.id=s.expert_registry_id
 WHERE s.id=p_slot;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample request unavailable';
 END IF;
 v_deadline := LEAST(clock_timestamp()+interval '10 minutes',
                    v_slot.starts_at-interval '1 second');
 v_hold := synthetic_hold_slot(v_member,p_slot,p_grant,v_key,
   encode(sha256((v_key || ':' || p_slot || ':' || p_grant)::bytea),'hex'),
   v_deadline,clock_timestamp());
 -- Under the existing slot/registry/staff/grant/member locks, recheck wall
 -- clock expiry after any wait. Any failed check rolls the whole write back.
 IF v_deadline<=clock_timestamp() OR NOT EXISTS(
   SELECT 1 FROM principals member
   JOIN expert_availability_slots s ON s.id=p_slot
   JOIN expert_registry e ON e.id=s.expert_registry_id
   JOIN synthetic_entitlement_grants g ON g.id=p_grant
   JOIN principals primary_staff ON primary_staff.id=e.staff_id
   JOIN principals backup_staff ON backup_staff.id=e.backup_staff_id
   WHERE member.id=v_member AND member.token_hash=p_token
     AND member.revoked_at IS NULL AND member.expires_at>clock_timestamp()
     AND g.expires_at>clock_timestamp() AND g.expired_at IS NULL
     AND primary_staff.expires_at>clock_timestamp()
     AND backup_staff.expires_at>clock_timestamp()
 ) THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample request unavailable';
 END IF;
 SELECT s.starts_at,s.ends_at,e.domain,e.service_type INTO v_slot
 FROM expert_availability_slots s JOIN expert_registry e ON e.id=s.expert_registry_id
 WHERE s.id=p_slot;
 INSERT INTO synthetic_member_hold_receipts
   (member_id,request_id,hold_id,slot_id,grant_id,domain,service_type,starts_at,ends_at)
 VALUES(v_member,p_request,v_hold,p_slot,p_grant,v_slot.domain,
        v_slot.service_type,v_slot.starts_at,v_slot.ends_at);
 RETURN p_request;
END $$;
INSERT INTO schema_migrations(version) VALUES(45) ON CONFLICT DO NOTHING;
COMMIT;
