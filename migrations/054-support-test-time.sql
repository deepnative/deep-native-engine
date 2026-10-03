BEGIN;
-- Private invented support effort only; historical requests remain unmetered.
CREATE UNIQUE INDEX IF NOT EXISTS support_requests_id_member_idx ON support_requests(id,member_id);
CREATE UNIQUE INDEX IF NOT EXISTS synthetic_grants_id_member_idx ON synthetic_entitlement_grants(id,member_id);
CREATE TABLE IF NOT EXISTS support_time_allocations (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 grant_id uuid NOT NULL,
 policy text NOT NULL DEFAULT 'support-time-test-v1' CHECK(policy='support-time-test-v1'),
 ceiling integer NOT NULL CHECK(ceiling BETWEEN 1 AND 120),
 idempotency_key uuid NOT NULL,
 state text NOT NULL DEFAULT 'allocated' CHECK(state IN ('allocated','begun','completed','cancelled','needs_reconciliation')),
 begun_by uuid,
 begun_grant_id uuid,
 begin_key uuid,
 begun_at timestamptz,
 settled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(request_id,member_id) REFERENCES support_requests(id,member_id) ON DELETE CASCADE,
 FOREIGN KEY(grant_id,member_id) REFERENCES synthetic_entitlement_grants(id,member_id) ON DELETE CASCADE,
 UNIQUE(member_id,request_id,idempotency_key),
 UNIQUE(id,request_id),
 CHECK((state='allocated' AND begun_by IS NULL AND begun_grant_id IS NULL AND begin_key IS NULL AND begun_at IS NULL AND settled_at IS NULL)
 OR (state IN ('begun','needs_reconciliation') AND begun_by IS NOT NULL AND begun_grant_id IS NOT NULL AND begin_key IS NOT NULL AND begun_at IS NOT NULL AND settled_at IS NULL)
 OR (state='completed' AND begun_by IS NOT NULL AND begun_grant_id IS NOT NULL AND begin_key IS NOT NULL AND begun_at IS NOT NULL AND settled_at IS NOT NULL)
 OR (state='cancelled' AND begun_by IS NULL AND begun_grant_id IS NULL AND begin_key IS NULL AND begun_at IS NULL AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS support_time_one_unresolved_idx ON support_time_allocations(request_id)
 WHERE state IN ('allocated','begun','needs_reconciliation');
CREATE INDEX IF NOT EXISTS support_time_owner_page_idx ON support_time_allocations(member_id,request_id,created_at,id);
CREATE INDEX IF NOT EXISTS support_time_grant_idx ON support_time_allocations(grant_id,id);
CREATE TABLE IF NOT EXISTS support_time_units (
 allocation_id uuid NOT NULL REFERENCES support_time_allocations(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 120),
 reservation_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_reservations(id) ON DELETE CASCADE,
 PRIMARY KEY(allocation_id,ordinal)
);
-- Historical actor/admin identifiers do not add cross-member principal FK locks.
-- Current active principal/profile/grant checks are performed under canonical locks.
CREATE TABLE IF NOT EXISTS support_time_grants (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL,
 request_id uuid NOT NULL,
 staff_id uuid NOT NULL,
 staff_role text NOT NULL CHECK(staff_role IN ('operator','platform_admin')),
 purpose text NOT NULL DEFAULT 'support-time-local-v1' CHECK(purpose='support-time-local-v1'),
 starts_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 granted_by uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(allocation_id,request_id) REFERENCES support_time_allocations(id,request_id) ON DELETE CASCADE,
 UNIQUE(granted_by,idempotency_key),
 UNIQUE(id,allocation_id),
 CHECK(isfinite(starts_at) AND isfinite(expires_at) AND expires_at>starts_at)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='support_time_allocations'::regclass AND conname='support_time_begin_grant_fkey') THEN
  ALTER TABLE support_time_allocations ADD CONSTRAINT support_time_begin_grant_fkey
   FOREIGN KEY(begun_grant_id,id) REFERENCES support_time_grants(id,allocation_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS support_time_grant_worklist_idx ON support_time_grants(staff_id,created_at DESC,id DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS support_time_grant_actor_idx ON support_time_grants(staff_id,allocation_id,id);
CREATE TABLE IF NOT EXISTS support_time_entries (
 allocation_id uuid PRIMARY KEY REFERENCES support_time_allocations(id) ON DELETE CASCADE,
 id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 support_start timestamptz NOT NULL,
 support_end timestamptz NOT NULL,
 preparation_start timestamptz,
 preparation_end timestamptz,
 support_minutes integer NOT NULL CHECK(support_minutes BETWEEN 1 AND 120),
 preparation_minutes integer NOT NULL CHECK(preparation_minutes BETWEEN 0 AND 119),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(grant_id,allocation_id) REFERENCES support_time_grants(id,allocation_id),
 CHECK(support_minutes+preparation_minutes<=120),
 CHECK(isfinite(support_start) AND isfinite(support_end) AND support_end>support_start
  AND extract(epoch FROM support_end-support_start)=support_minutes*60),
 CHECK((preparation_minutes=0 AND preparation_start IS NULL AND preparation_end IS NULL)
  OR (preparation_minutes>0 AND preparation_start IS NOT NULL AND preparation_end IS NOT NULL
   AND isfinite(preparation_start) AND isfinite(preparation_end) AND preparation_end>preparation_start
   AND extract(epoch FROM preparation_end-preparation_start)=preparation_minutes*60
   AND (preparation_end<=support_start OR support_end<=preparation_start)))
);
CREATE INDEX IF NOT EXISTS support_time_entry_actor_start_idx ON support_time_entries(actor_id,support_start,allocation_id);
CREATE INDEX IF NOT EXISTS support_time_entry_actor_prep_idx ON support_time_entries(actor_id,preparation_start,allocation_id) WHERE preparation_start IS NOT NULL;
CREATE TABLE IF NOT EXISTS support_time_events (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL REFERENCES support_time_allocations(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('allocated','begun','recorded','cancelled','withdrawn','needs-reconciliation','grant-created','grant-revoked','detail-read','worklist-read')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS support_time_events_allocation_idx ON support_time_events(allocation_id,id);

CREATE OR REPLACE FUNCTION preserve_support_time_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN RAISE EXCEPTION 'Support time history requires member erasure'; END IF;
  RETURN OLD;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','begun_by','begun_grant_id','begin_key','begun_at','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','begun_by','begun_grant_id','begin_key','begun_at','settled_at'])
 OR (OLD.begun_at IS NOT NULL AND (NEW.begun_by,NEW.begun_grant_id,NEW.begin_key,NEW.begun_at) IS DISTINCT FROM (OLD.begun_by,OLD.begun_grant_id,OLD.begin_key,OLD.begun_at))
 OR (OLD.state IN ('completed','cancelled','needs_reconciliation') AND NEW IS DISTINCT FROM OLD)
 OR (OLD.state='allocated' AND NEW.state NOT IN ('allocated','begun','cancelled'))
 OR (OLD.state='begun' AND NEW.state NOT IN ('begun','completed','needs_reconciliation'))
 THEN RAISE EXCEPTION 'Support time allocation identity and outcome are immutable'; END IF;
 IF OLD.state='allocated' AND NEW.state='begun' AND NOT EXISTS(
  SELECT 1 FROM support_time_grants g JOIN principals p ON p.id=g.staff_id AND p.kind='staff'
  JOIN staff_profiles profile ON profile.principal_id=p.id AND profile.role=g.staff_role
  JOIN support_requests r ON r.id=NEW.request_id AND r.member_id=NEW.member_id
  JOIN synthetic_entitlement_grants budget ON budget.id=NEW.grant_id
  WHERE g.id=NEW.begun_grant_id AND g.allocation_id=NEW.id AND g.request_id=NEW.request_id AND g.staff_id=NEW.begun_by
   AND g.purpose='support-time-local-v1' AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND r.withdrawn_at IS NULL
   AND budget.expired_at IS NULL AND budget.starts_at<=clock_timestamp() AND budget.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Support time begin authority unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_allocation_immutable ON support_time_allocations;
CREATE TRIGGER support_time_allocation_immutable BEFORE UPDATE OR DELETE ON support_time_allocations
 FOR EACH ROW EXECUTE FUNCTION preserve_support_time_allocation();

CREATE OR REPLACE FUNCTION preserve_support_time_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Support time record is immutable'; END IF;
 SELECT member_id INTO owner_id FROM support_time_allocations WHERE id=OLD.allocation_id;
 IF EXISTS(SELECT 1 FROM learners WHERE id=owner_id) THEN RAISE EXCEPTION 'Support time history requires member erasure'; END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS support_time_units_immutable ON support_time_units;
CREATE TRIGGER support_time_units_immutable BEFORE UPDATE OR DELETE ON support_time_units FOR EACH ROW EXECUTE FUNCTION preserve_support_time_child();
DROP TRIGGER IF EXISTS support_time_entries_immutable ON support_time_entries;
CREATE TRIGGER support_time_entries_immutable BEFORE UPDATE OR DELETE ON support_time_entries FOR EACH ROW EXECUTE FUNCTION preserve_support_time_child();
DROP TRIGGER IF EXISTS support_time_events_immutable ON support_time_events;
CREATE TRIGGER support_time_events_immutable BEFORE UPDATE OR DELETE ON support_time_events FOR EACH ROW EXECUTE FUNCTION preserve_support_time_child();
DROP TRIGGER IF EXISTS support_time_grants_immutable ON support_time_grants;
CREATE TRIGGER support_time_grants_immutable BEFORE UPDATE ON support_time_grants FOR EACH ROW EXECUTE FUNCTION preserve_support_grant();
DROP TRIGGER IF EXISTS support_time_grants_removal ON support_time_grants;
CREATE TRIGGER support_time_grants_removal BEFORE DELETE ON support_time_grants FOR EACH ROW EXECUTE FUNCTION preserve_support_time_child();

CREATE OR REPLACE FUNCTION guard_support_time_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; r record;
BEGIN
 SELECT * INTO a FROM support_time_allocations WHERE id=NEW.allocation_id;
 SELECT r0.*,g.member_id,g.category INTO r FROM synthetic_entitlement_reservations r0
 JOIN synthetic_entitlement_grants g ON g.id=r0.grant_id WHERE r0.id=NEW.reservation_id FOR UPDATE OF r0,g;
 IF a.id IS NULL OR r.id IS NULL OR a.state<>'allocated' OR NEW.ordinal>a.ceiling
  OR r.grant_id<>a.grant_id OR r.member_id<>a.member_id OR r.category<>'support_minutes' OR r.quantity<>1 OR r.state<>'reserved'
  OR EXISTS(SELECT 1 FROM synthetic_slot_holds WHERE reservation_id=r.id)
  OR EXISTS(SELECT 1 FROM local_ai_test_unit_jobs WHERE reservation_id=r.id)
 THEN RAISE EXCEPTION 'Invalid support time unit linkage'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_unit_guard ON support_time_units;
CREATE TRIGGER support_time_unit_guard BEFORE INSERT ON support_time_units FOR EACH ROW EXECUTE FUNCTION guard_support_time_unit();

CREATE OR REPLACE FUNCTION guard_support_time_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; accepted_at timestamptz;
BEGIN
 -- Stable per-operator serialization precedes allocation/ledger writes in callers.
 PERFORM pg_advisory_xact_lock(44154,hashtext(NEW.actor_id::text));
 SELECT * INTO a FROM support_time_allocations WHERE id=NEW.allocation_id;
 accepted_at=clock_timestamp();
 IF a.id IS NULL OR a.state<>'begun' OR a.begun_by<>NEW.actor_id
  OR NEW.grant_id IS DISTINCT FROM a.begun_grant_id
  OR NOT EXISTS(SELECT 1 FROM support_time_grants g JOIN principals p ON p.id=g.staff_id AND p.kind='staff'
   JOIN staff_profiles profile ON profile.principal_id=p.id AND profile.role=g.staff_role
   WHERE g.id=NEW.grant_id AND g.staff_id=NEW.actor_id AND g.allocation_id=a.id AND g.revoked_at IS NULL
    AND g.starts_at<=accepted_at AND g.expires_at>accepted_at AND p.revoked_at IS NULL AND p.expires_at>accepted_at)
  OR NEW.support_minutes+NEW.preparation_minutes>a.ceiling
  OR NEW.support_start<accepted_at-interval '24 hours' OR NEW.support_end>accepted_at
  OR (NEW.preparation_start IS NOT NULL AND (NEW.preparation_start<accepted_at-interval '24 hours' OR NEW.preparation_end>accepted_at))
 THEN RAISE EXCEPTION 'Invalid support time entry'; END IF;
 IF EXISTS(SELECT 1 FROM support_time_entries e WHERE e.actor_id=NEW.actor_id AND
  (tstzrange(e.support_start,e.support_end,'[)') && tstzrange(NEW.support_start,NEW.support_end,'[)')
   OR (NEW.preparation_start IS NOT NULL AND tstzrange(e.support_start,e.support_end,'[)') && tstzrange(NEW.preparation_start,NEW.preparation_end,'[)'))
   OR (e.preparation_start IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange(NEW.support_start,NEW.support_end,'[)'))
   OR (e.preparation_start IS NOT NULL AND NEW.preparation_start IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange(NEW.preparation_start,NEW.preparation_end,'[)'))))
 THEN RAISE EXCEPTION 'Support time entry conflicts'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_entry_guard ON support_time_entries;
CREATE TRIGGER support_time_entry_guard BEFORE INSERT ON support_time_entries FOR EACH ROW EXECUTE FUNCTION guard_support_time_entry();

CREATE OR REPLACE FUNCTION guard_support_time_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked record;
BEGIN
 SELECT a.state,u.ordinal,e.id AS entry_id,e.support_minutes+e.preparation_minutes AS used
 INTO linked FROM support_time_units u JOIN support_time_allocations a ON a.id=u.allocation_id
 LEFT JOIN support_time_entries e ON e.allocation_id=a.id WHERE u.reservation_id=OLD.id;
 IF NOT FOUND OR NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF (NEW.id,NEW.grant_id,NEW.quantity,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.grant_id,OLD.quantity,OLD.created_at)
 OR OLD.state<>'reserved'
 OR (NEW.state='consumed' AND NOT (linked.state='begun' AND linked.entry_id IS NOT NULL AND linked.ordinal<=linked.used))
 OR (NEW.state='released' AND NOT (linked.state='allocated' OR (linked.state='begun' AND linked.entry_id IS NOT NULL AND linked.ordinal>linked.used)))
 OR NEW.state NOT IN ('consumed','released')
 THEN RAISE EXCEPTION 'Protected support unit transition unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_reservation_guard ON synthetic_entitlement_reservations;
CREATE TRIGGER support_time_reservation_guard BEFORE UPDATE ON synthetic_entitlement_reservations
 FOR EACH ROW EXECUTE FUNCTION guard_support_time_reservation();
CREATE INDEX IF NOT EXISTS synthetic_events_reservation_operation_idx ON synthetic_entitlement_events(reservation_id,operation);

CREATE OR REPLACE FUNCTION assert_support_time_allocation(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; facts record; e record;
BEGIN
 SELECT * INTO a FROM support_time_allocations WHERE id=p_id;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT count(*) n,count(*) FILTER(WHERE r.state='reserved') held,
 count(*) FILTER(WHERE r.state='consumed') used,count(*) FILTER(WHERE r.state='released') returned,
 bool_and(r.quantity=1 AND r.grant_id=a.grant_id AND g.member_id=a.member_id AND g.category='support_minutes'
  AND f.reserves=1 AND f.valid IS NOT DISTINCT FROM true
  AND ((r.state='reserved' AND f.consumes=0 AND f.releases=0)
   OR (r.state='consumed' AND f.consumes=1 AND f.releases=0)
   OR (r.state='released' AND f.consumes=0 AND f.releases=1))) valid
 INTO facts FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id
 JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
 LEFT JOIN LATERAL (
  SELECT count(*) FILTER(WHERE operation='reserve') reserves,count(*) FILTER(WHERE operation='consume') consumes,
   count(*) FILTER(WHERE operation='release') releases,
   bool_and(member_id=a.member_id AND grant_id=a.grant_id AND quantity=1 AND result_id=r.id
    AND operation IN ('reserve','consume','release')) valid
  FROM synthetic_entitlement_events WHERE reservation_id=r.id
 ) f ON true WHERE u.allocation_id=a.id;
 SELECT * INTO e FROM support_time_entries WHERE allocation_id=a.id;
 IF facts.n<>a.ceiling OR facts.valid IS DISTINCT FROM true
 OR (a.state IN ('allocated','begun','needs_reconciliation') AND (facts.held<>a.ceiling OR e.id IS NOT NULL))
 OR (a.state='cancelled' AND (facts.returned<>a.ceiling OR e.id IS NOT NULL))
 OR (a.state='completed' AND (e.id IS NULL OR e.actor_id<>a.begun_by OR e.grant_id<>a.begun_grant_id OR facts.used<>e.support_minutes+e.preparation_minutes OR facts.returned<>a.ceiling-facts.used))
 THEN RAISE EXCEPTION 'Support time allocation and unit outcomes must agree'; END IF;
END $$;
CREATE OR REPLACE FUNCTION check_support_time_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='support_time_allocations' THEN
  PERFORM assert_support_time_allocation(NEW.id);
 ELSE
  PERFORM assert_support_time_allocation(NEW.allocation_id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_allocation_consistency ON support_time_allocations;
CREATE CONSTRAINT TRIGGER support_time_allocation_consistency AFTER INSERT OR UPDATE ON support_time_allocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_support_time_allocation();
DROP TRIGGER IF EXISTS support_time_unit_consistency ON support_time_units;
CREATE CONSTRAINT TRIGGER support_time_unit_consistency AFTER INSERT ON support_time_units
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_support_time_allocation();
DROP TRIGGER IF EXISTS support_time_entry_consistency ON support_time_entries;
CREATE CONSTRAINT TRIGGER support_time_entry_consistency AFTER INSERT ON support_time_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_support_time_allocation();

CREATE OR REPLACE FUNCTION check_support_time_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation uuid;
BEGIN
 SELECT allocation_id INTO allocation FROM support_time_units WHERE reservation_id=NEW.id;
 IF allocation IS NOT NULL THEN PERFORM assert_support_time_allocation(allocation); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_reservation_consistency ON synthetic_entitlement_reservations;
CREATE CONSTRAINT TRIGGER support_time_reservation_consistency AFTER UPDATE ON synthetic_entitlement_reservations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_support_time_reservation();

-- Preserve the old four-argument contract. Both domains use one balance body.
CREATE OR REPLACE FUNCTION release_synthetic_reservation_balance(
 p_reservation uuid,p_member uuid,p_at timestamptz,p_job uuid,p_support uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_row record; linked_job uuid; linked_support uuid; effective_at timestamptz;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) OR (p_job IS NOT NULL AND p_support IS NOT NULL) THEN RAISE EXCEPTION 'Invalid release authority'; END IF;
 SELECT r.grant_id,r.quantity,r.state,g.expires_at,g.expired_at INTO current_row
 FROM synthetic_entitlement_reservations r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
 WHERE r.id=p_reservation AND g.member_id=p_member
 AND NOT EXISTS(SELECT 1 FROM synthetic_slot_holds h WHERE h.reservation_id=r.id) FOR UPDATE OF r,g;
 IF NOT FOUND OR current_row.state<>'reserved' THEN RAISE EXCEPTION 'Reservation unavailable'; END IF;
 SELECT job_id INTO linked_job FROM local_ai_test_unit_jobs WHERE reservation_id=p_reservation;
 SELECT allocation_id INTO linked_support FROM support_time_units WHERE reservation_id=p_reservation;
 IF linked_job IS DISTINCT FROM p_job OR linked_support IS DISTINCT FROM p_support THEN RAISE EXCEPTION 'Reservation belongs to a protected operation'; END IF;
 IF p_job IS NOT NULL AND NOT EXISTS(SELECT 1 FROM adapter_jobs WHERE id=p_job AND member_id=p_member AND status='pending' AND attempt_count=0)
 THEN RAISE EXCEPTION 'Dispatched local request remains held'; END IF;
 IF p_support IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM support_time_allocations a JOIN support_time_units u ON u.allocation_id=a.id
  LEFT JOIN support_time_entries e ON e.allocation_id=a.id
  WHERE a.id=p_support AND a.member_id=p_member AND a.grant_id=current_row.grant_id AND u.reservation_id=p_reservation
   AND (a.state='allocated' OR (a.state='begun' AND e.id IS NOT NULL AND u.ordinal>e.support_minutes+e.preparation_minutes)))
 THEN RAISE EXCEPTION 'Started support without a known completion remains held'; END IF;
 effective_at=CASE WHEN p_support IS NOT NULL THEN clock_timestamp() ELSE p_at END;
 IF current_row.expired_at IS NOT NULL OR effective_at>=current_row.expires_at THEN
  UPDATE synthetic_entitlement_grants SET reserved=reserved-current_row.quantity,expired=expired+current_row.quantity WHERE id=current_row.grant_id;
 ELSE
  UPDATE synthetic_entitlement_grants SET reserved=reserved-current_row.quantity,available=available+current_row.quantity WHERE id=current_row.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=p_reservation;
END $$;
CREATE OR REPLACE FUNCTION release_synthetic_reservation_balance(
 p_reservation uuid,p_member uuid,p_at timestamptz,p_job uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM release_synthetic_reservation_balance(p_reservation,p_member,p_at,p_job,NULL); END $$;
CREATE OR REPLACE FUNCTION withdraw_support_time() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; unit record; event_key text; fingerprint text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM learners WHERE id=NEW.member_id) THEN RETURN NEW; END IF;
 FOR a IN SELECT * FROM support_time_allocations WHERE request_id=NEW.id
   AND state IN ('allocated','begun') ORDER BY id FOR UPDATE LOOP
  IF a.state='allocated' THEN
   FOR unit IN SELECT u.ordinal,u.reservation_id,r.grant_id FROM support_time_units u
    JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id ORDER BY u.ordinal LOOP
    PERFORM release_synthetic_reservation_balance(unit.reservation_id,a.member_id,clock_timestamp(),NULL,a.id);
    event_key='support-time:'||a.id::text||':unit:'||unit.ordinal::text||':release';
    fingerprint=encode(sha256(convert_to(format('{"operation":"release","memberId":"%s","reservationId":"%s"}',a.member_id,unit.reservation_id),'UTF8')),'hex');
    INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
    VALUES(gen_random_uuid(),a.member_id,unit.grant_id,unit.reservation_id,'release',1,event_key,fingerprint,unit.reservation_id);
   END LOOP;
   UPDATE support_time_allocations SET state='cancelled',settled_at=clock_timestamp() WHERE id=a.id;
   INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES(gen_random_uuid(),a.id,a.member_id,NEW.member_id,'withdrawn');
  ELSE
   UPDATE support_time_allocations SET state='needs_reconciliation' WHERE id=a.id;
   INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES(gen_random_uuid(),a.id,a.member_id,NEW.member_id,'needs-reconciliation');
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_request_withdrawal ON support_requests;
CREATE TRIGGER support_time_request_withdrawal AFTER UPDATE OF withdrawn_at ON support_requests
 FOR EACH ROW WHEN(OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) EXECUTE FUNCTION withdraw_support_time();
CREATE OR REPLACE FUNCTION revoke_support_time_begin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM support_time_allocations WHERE id=NEW.allocation_id FOR UPDATE;
 IF a.state='begun' AND a.begun_grant_id=NEW.id THEN
  UPDATE support_time_allocations SET state='needs_reconciliation' WHERE id=a.id;
  INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES(gen_random_uuid(),a.id,a.member_id,NEW.granted_by,'needs-reconciliation');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_time_begin_revocation ON support_time_grants;
CREATE TRIGGER support_time_begin_revocation AFTER UPDATE OF revoked_at ON support_time_grants
 FOR EACH ROW WHEN(OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION revoke_support_time_begin();
INSERT INTO schema_migrations(version) VALUES(54) ON CONFLICT DO NOTHING;
COMMIT;
