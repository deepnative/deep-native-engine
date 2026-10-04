BEGIN;
-- Optional invented-data review accounting. No historical feedback is billed
-- and no entitlement or reviewer permission is created by this migration.
CREATE TABLE IF NOT EXISTS review_time_allocations (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 -- Keep an opaque operation identity after private source erasure. Live source
 -- links disappear; no filename, source digest, quote or feedback text remains.
 source_key uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 evidence_id uuid REFERENCES evidence_objects(id) ON DELETE SET NULL,
 submission_id uuid REFERENCES evidence_review_submissions(id) ON DELETE SET NULL,
 source_unavailable_at timestamptz,
 grant_id uuid NOT NULL,
 policy text NOT NULL DEFAULT 'review-time-test-v1' CHECK(policy='review-time-test-v1'),
 ceiling integer NOT NULL CHECK(ceiling BETWEEN 1 AND 120),
 idempotency_key uuid NOT NULL,
 state text NOT NULL DEFAULT 'allocated' CHECK(state IN ('allocated','begun','completed','cancelled','needs_reconciliation')),
 begun_by uuid,
 begun_grant_id uuid,
 begin_key uuid,
 begun_at timestamptz,
 settled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(grant_id,member_id) REFERENCES synthetic_entitlement_grants(id,member_id) ON DELETE CASCADE,
 UNIQUE(member_id,source_key,idempotency_key),
 CHECK(isfinite(created_at)),
 CHECK(source_unavailable_at IS NULL OR isfinite(source_unavailable_at)),
 CHECK(begun_at IS NULL OR isfinite(begun_at)),
 CHECK(settled_at IS NULL OR isfinite(settled_at)),
 CHECK((state='allocated' AND begun_by IS NULL AND begun_grant_id IS NULL AND begin_key IS NULL AND begun_at IS NULL AND settled_at IS NULL)
  OR (state IN ('begun','needs_reconciliation') AND begun_by IS NOT NULL AND begun_grant_id IS NOT NULL AND begin_key IS NOT NULL AND begun_at IS NOT NULL AND settled_at IS NULL)
  OR (state='completed' AND begun_by IS NOT NULL AND begun_grant_id IS NOT NULL AND begin_key IS NOT NULL AND begun_at IS NOT NULL AND settled_at IS NOT NULL)
  OR (state='cancelled' AND begun_by IS NULL AND begun_grant_id IS NULL AND begin_key IS NULL AND begun_at IS NULL AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS review_time_one_unresolved_idx ON review_time_allocations(source_key)
 WHERE state IN ('allocated','begun','needs_reconciliation');
CREATE INDEX IF NOT EXISTS review_time_owner_page_idx ON review_time_allocations(member_id,id);
CREATE INDEX IF NOT EXISTS review_time_evidence_idx ON review_time_allocations(evidence_id,id);
CREATE INDEX IF NOT EXISTS review_time_submission_idx ON review_time_allocations(submission_id,id);
CREATE INDEX IF NOT EXISTS review_time_budget_idx ON review_time_allocations(grant_id,id);
CREATE TABLE IF NOT EXISTS review_time_units (
 allocation_id uuid NOT NULL REFERENCES review_time_allocations(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 120),
 reservation_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_reservations(id) ON DELETE CASCADE,
 PRIMARY KEY(allocation_id,ordinal)
);
-- This purpose is allocation-specific. It never substitutes for the separate
-- current workspace assignment and exact feedback-publication permission.
CREATE TABLE IF NOT EXISTS review_time_grants (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL REFERENCES review_time_allocations(id) ON DELETE CASCADE,
 staff_id uuid NOT NULL,
 staff_role text NOT NULL DEFAULT 'reviewer' CHECK(staff_role='reviewer'),
 purpose text NOT NULL DEFAULT 'review-time-local-v1' CHECK(purpose='review-time-local-v1'),
 starts_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 granted_by uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(granted_by,idempotency_key),
 UNIQUE(id,allocation_id),
 CHECK(isfinite(starts_at) AND isfinite(expires_at) AND expires_at>starts_at)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='review_time_allocations'::regclass AND conname='review_time_begin_grant_fkey') THEN
  ALTER TABLE review_time_allocations ADD CONSTRAINT review_time_begin_grant_fkey
   FOREIGN KEY(begun_grant_id,id) REFERENCES review_time_grants(id,allocation_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS review_time_grant_worklist_idx ON review_time_grants(staff_id,id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS review_time_entries (
 allocation_id uuid PRIMARY KEY REFERENCES review_time_allocations(id) ON DELETE CASCADE,
 id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 feedback_id uuid REFERENCES private_sample_feedback(id) ON DELETE SET NULL,
 draft_revision integer NOT NULL CHECK(draft_revision>0),
 publication_operation_id uuid NOT NULL,
 review_start timestamptz NOT NULL,
 review_end timestamptz NOT NULL,
 preparation_start timestamptz,
 preparation_end timestamptz,
 review_minutes integer NOT NULL CHECK(review_minutes BETWEEN 1 AND 120),
 preparation_minutes integer NOT NULL CHECK(preparation_minutes BETWEEN 0 AND 119),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(grant_id,allocation_id) REFERENCES review_time_grants(id,allocation_id),
 CHECK(review_minutes+preparation_minutes<=120),
 CHECK(isfinite(review_start) AND isfinite(review_end) AND review_end>review_start
  AND extract(epoch FROM review_end-review_start)=review_minutes*60),
 CHECK((preparation_minutes=0 AND preparation_start IS NULL AND preparation_end IS NULL)
  OR (preparation_minutes>0 AND preparation_start IS NOT NULL AND preparation_end IS NOT NULL
   AND isfinite(preparation_start) AND isfinite(preparation_end) AND preparation_end>preparation_start
   AND extract(epoch FROM preparation_end-preparation_start)=preparation_minutes*60
   AND (preparation_end<=review_start OR review_end<=preparation_start)))
);
CREATE INDEX IF NOT EXISTS review_time_entry_actor_start_idx ON review_time_entries(actor_id,review_start,allocation_id);
CREATE INDEX IF NOT EXISTS review_time_entry_actor_prep_idx ON review_time_entries(actor_id,preparation_start,allocation_id) WHERE preparation_start IS NOT NULL;
CREATE TABLE IF NOT EXISTS review_time_events (
 id uuid PRIMARY KEY,
 allocation_id uuid NOT NULL REFERENCES review_time_allocations(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('allocated','begun','published','cancelled','withdrawn','source-erased','needs-reconciliation','grant-created','grant-revoked','detail-read','worklist-read')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS review_time_events_allocation_idx ON review_time_events(allocation_id,id);

-- All application writers must lock the actor before workspace/source rows.
-- These predicates supplement, rather than replace, held authority/deadlines.
CREATE OR REPLACE FUNCTION review_time_authorized(p_allocation uuid,p_actor uuid,p_grant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM review_time_allocations a
  JOIN review_time_grants g ON g.allocation_id=a.id AND g.id=p_grant AND g.staff_id=p_actor
  JOIN principals p ON p.id=g.staff_id AND p.kind='staff'
  JOIN staff_profiles profile ON profile.principal_id=p.id AND profile.role='reviewer'
  JOIN workspaces w ON w.id=a.workspace_id AND w.deleting_at IS NULL
  JOIN evidence_objects source ON source.id=a.evidence_id AND source.workspace_id=w.id
  JOIN evidence_review_submissions submission ON submission.id=a.submission_id AND submission.evidence_id=source.id
  WHERE a.id=p_allocation AND a.source_unavailable_at IS NULL
   AND source.owner_principal_id=a.member_id AND source.revision_number=a.source_revision
   AND source.private_review_allowed AND source.quarantine_state='clean' AND submission.status='queued'
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
   AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
   AND EXISTS(
    SELECT 1 FROM assignment_grants assignment JOIN reviewer_evidence_grants exact ON exact.assignment_id=assignment.id
    WHERE assignment.staff_id=p_actor AND assignment.staff_role='reviewer' AND assignment.workspace_id=w.id
     AND assignment.revoked_at IS NULL AND assignment.starts_at<=clock_timestamp() AND assignment.expires_at>clock_timestamp()
     AND exact.submission_id=submission.id AND exact.reviewer_id=p_actor AND exact.purpose='private_sample_feedback_v1'
     AND exact.revoked_at IS NULL AND exact.starts_at<=clock_timestamp() AND exact.expires_at>clock_timestamp())
 );
$$;
CREATE OR REPLACE FUNCTION guard_review_time_allocation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'allocated' OR NEW.source_unavailable_at IS NOT NULL
 OR NEW.source_key IS DISTINCT FROM NEW.submission_id
 OR NOT EXISTS(
  SELECT 1 FROM evidence_objects e JOIN evidence_review_submissions s ON s.evidence_id=e.id
  JOIN workspaces w ON w.id=e.workspace_id
  JOIN synthetic_entitlement_grants g ON g.id=NEW.grant_id AND g.member_id=NEW.member_id
  WHERE e.id=NEW.evidence_id AND s.id=NEW.submission_id AND s.submitted_by=NEW.member_id
   AND e.owner_principal_id=NEW.member_id AND w.id=NEW.workspace_id AND w.deleting_at IS NULL
   AND e.revision_number=NEW.source_revision AND e.private_review_allowed AND e.quarantine_state='clean'
   AND s.status='queued' AND g.category='review_minutes' AND g.available>=NEW.ceiling
   AND g.expired_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM private_sample_feedback f WHERE f.submission_id=s.id AND f.published_at IS NOT NULL))
 THEN RAISE EXCEPTION 'Review allocation source or budget unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_allocation_insert_guard ON review_time_allocations;
CREATE TRIGGER review_time_allocation_insert_guard BEFORE INSERT ON review_time_allocations
 FOR EACH ROW EXECUTE FUNCTION guard_review_time_allocation_insert();
CREATE OR REPLACE FUNCTION preserve_review_time_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id)
   AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND deleting_at IS NULL)
  THEN RAISE EXCEPTION 'Review accounting history requires owner erasure'; END IF;
  RETURN OLD;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','begun_by','begun_grant_id','begin_key','begun_at','settled_at','evidence_id','submission_id','source_unavailable_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','begun_by','begun_grant_id','begin_key','begun_at','settled_at','evidence_id','submission_id','source_unavailable_at'])
 OR (OLD.begun_at IS NOT NULL AND (NEW.begun_by,NEW.begun_grant_id,NEW.begin_key,NEW.begun_at) IS DISTINCT FROM (OLD.begun_by,OLD.begun_grant_id,OLD.begin_key,OLD.begun_at))
 OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
 OR (OLD.state IN ('completed','cancelled','needs_reconciliation') AND NEW.state<>OLD.state)
 OR (OLD.state='allocated' AND NEW.state NOT IN ('allocated','begun','cancelled'))
 OR (OLD.state='begun' AND NEW.state NOT IN ('begun','completed','needs_reconciliation'))
 THEN RAISE EXCEPTION 'Review allocation identity and outcome are immutable'; END IF;
 IF (NEW.evidence_id,NEW.submission_id,NEW.source_unavailable_at) IS DISTINCT FROM (OLD.evidence_id,OLD.submission_id,OLD.source_unavailable_at) THEN
  IF (NEW.evidence_id IS DISTINCT FROM OLD.evidence_id AND NEW.evidence_id IS NOT NULL)
   OR (NEW.submission_id IS DISTINCT FROM OLD.submission_id AND NEW.submission_id IS NOT NULL)
   OR NEW.source_unavailable_at IS NULL
   OR (OLD.source_unavailable_at IS NOT NULL AND NEW.source_unavailable_at IS DISTINCT FROM OLD.source_unavailable_at)
   OR EXISTS(SELECT 1 FROM evidence_objects WHERE id=OLD.evidence_id AND quarantine_state<>'deleting')
  THEN RAISE EXCEPTION 'Review source links permit only source erasure'; END IF;
 END IF;
 IF OLD.state='allocated' AND NEW.state='begun' AND (
  NOT review_time_authorized(NEW.id,NEW.begun_by,NEW.begun_grant_id)
  OR NOT EXISTS(SELECT 1 FROM synthetic_entitlement_grants WHERE id=NEW.grant_id
   AND expired_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()))
 THEN RAISE EXCEPTION 'Review begin authority unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_allocation_immutable ON review_time_allocations;
CREATE TRIGGER review_time_allocation_immutable BEFORE UPDATE OR DELETE ON review_time_allocations
 FOR EACH ROW EXECUTE FUNCTION preserve_review_time_allocation();

CREATE OR REPLACE FUNCTION guard_review_time_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; r record;
BEGIN
 SELECT * INTO a FROM review_time_allocations WHERE id=NEW.allocation_id;
 SELECT r0.*,g.member_id,g.category INTO r FROM synthetic_entitlement_reservations r0
 JOIN synthetic_entitlement_grants g ON g.id=r0.grant_id WHERE r0.id=NEW.reservation_id FOR UPDATE OF r0,g;
 IF a.id IS NULL OR r.id IS NULL OR a.state<>'allocated' OR NEW.ordinal>a.ceiling
  OR r.grant_id<>a.grant_id OR r.member_id<>a.member_id OR r.category<>'review_minutes' OR r.quantity<>1 OR r.state<>'reserved'
  OR EXISTS(SELECT 1 FROM synthetic_slot_holds WHERE reservation_id=r.id)
  OR EXISTS(SELECT 1 FROM local_ai_test_unit_jobs WHERE reservation_id=r.id)
  OR EXISTS(SELECT 1 FROM support_time_units WHERE reservation_id=r.id)
 THEN RAISE EXCEPTION 'Invalid review time unit linkage'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_unit_guard ON review_time_units;
CREATE TRIGGER review_time_unit_guard BEFORE INSERT ON review_time_units FOR EACH ROW EXECUTE FUNCTION guard_review_time_unit();

CREATE OR REPLACE FUNCTION guard_review_time_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; accepted_at timestamptz;
BEGIN
 -- Stable per-operator serialization precedes allocation/ledger writes in callers.
 PERFORM pg_advisory_xact_lock(44154,hashtext(NEW.actor_id::text));
 SELECT * INTO a FROM review_time_allocations WHERE id=NEW.allocation_id;
 accepted_at=clock_timestamp();
 IF a.id IS NULL OR a.state<>'begun' OR a.begun_by<>NEW.actor_id
  OR NEW.grant_id IS DISTINCT FROM a.begun_grant_id
  OR NOT EXISTS(SELECT 1 FROM review_time_grants g JOIN principals p ON p.id=g.staff_id AND p.kind='staff'
   JOIN staff_profiles profile ON profile.principal_id=p.id AND profile.role=g.staff_role
   WHERE g.id=NEW.grant_id AND g.staff_id=NEW.actor_id AND g.allocation_id=a.id AND g.revoked_at IS NULL
    AND g.starts_at<=accepted_at AND g.expires_at>accepted_at AND p.revoked_at IS NULL AND p.expires_at>accepted_at)
  OR NOT review_time_authorized(a.id,NEW.actor_id,NEW.grant_id)
  OR NOT EXISTS(SELECT 1 FROM private_sample_feedback f WHERE f.id=NEW.feedback_id AND f.submission_id=a.submission_id
   AND f.reviewer_id=NEW.actor_id AND f.draft_revision=NEW.draft_revision AND f.published_at IS NULL)
  OR NEW.review_minutes+NEW.preparation_minutes>a.ceiling
  OR NEW.review_start<accepted_at-interval '24 hours' OR NEW.review_end>accepted_at
  OR (NEW.preparation_start IS NOT NULL AND (NEW.preparation_start<accepted_at-interval '24 hours' OR NEW.preparation_end>accepted_at))
 THEN RAISE EXCEPTION 'Invalid review time entry'; END IF;
 IF EXISTS(SELECT 1 FROM review_time_entries e WHERE e.actor_id=NEW.actor_id AND
  (tstzrange(e.review_start,e.review_end,'[)') && tstzrange(NEW.review_start,NEW.review_end,'[)')
   OR (NEW.preparation_start IS NOT NULL AND tstzrange(e.review_start,e.review_end,'[)') && tstzrange(NEW.preparation_start,NEW.preparation_end,'[)'))
   OR (e.preparation_start IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange(NEW.review_start,NEW.review_end,'[)'))
   OR (e.preparation_start IS NOT NULL AND NEW.preparation_start IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange(NEW.preparation_start,NEW.preparation_end,'[)'))))
 THEN RAISE EXCEPTION 'Review time entry conflicts'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_entry_guard ON review_time_entries;
CREATE TRIGGER review_time_entry_guard BEFORE INSERT ON review_time_entries FOR EACH ROW EXECUTE FUNCTION guard_review_time_entry();

CREATE OR REPLACE FUNCTION guard_review_time_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked record;
BEGIN
 SELECT a.state,u.ordinal,e.id AS entry_id,e.review_minutes+e.preparation_minutes AS used
 INTO linked FROM review_time_units u JOIN review_time_allocations a ON a.id=u.allocation_id
 LEFT JOIN review_time_entries e ON e.allocation_id=a.id WHERE u.reservation_id=OLD.id;
 IF NOT FOUND OR NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF (NEW.id,NEW.grant_id,NEW.quantity,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.grant_id,OLD.quantity,OLD.created_at)
 OR OLD.state<>'reserved'
 OR (NEW.state='consumed' AND NOT (linked.state='begun' AND linked.entry_id IS NOT NULL AND linked.ordinal<=linked.used))
 OR (NEW.state='released' AND NOT (linked.state='allocated' OR (linked.state='begun' AND linked.entry_id IS NOT NULL AND linked.ordinal>linked.used)))
 OR NEW.state NOT IN ('consumed','released')
 THEN RAISE EXCEPTION 'Protected support unit transition unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_reservation_guard ON synthetic_entitlement_reservations;
CREATE TRIGGER review_time_reservation_guard BEFORE UPDATE ON synthetic_entitlement_reservations
 FOR EACH ROW EXECUTE FUNCTION guard_review_time_reservation();
CREATE INDEX IF NOT EXISTS synthetic_events_reservation_operation_idx ON synthetic_entitlement_events(reservation_id,operation);

CREATE OR REPLACE FUNCTION assert_review_time_allocation(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; facts record; e record;
BEGIN
 SELECT * INTO a FROM review_time_allocations WHERE id=p_id;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT count(*) n,count(*) FILTER(WHERE r.state='reserved') held,
 count(*) FILTER(WHERE r.state='consumed') used,count(*) FILTER(WHERE r.state='released') returned,
 bool_and(r.quantity=1 AND r.grant_id=a.grant_id AND g.member_id=a.member_id AND g.category='review_minutes'
  AND f.reserves=1 AND f.valid IS NOT DISTINCT FROM true
  AND ((r.state='reserved' AND f.consumes=0 AND f.releases=0)
   OR (r.state='consumed' AND f.consumes=1 AND f.releases=0)
   OR (r.state='released' AND f.consumes=0 AND f.releases=1))) valid
 INTO facts FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id
 JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
 LEFT JOIN LATERAL (
  SELECT count(*) FILTER(WHERE operation='reserve') reserves,count(*) FILTER(WHERE operation='consume') consumes,
   count(*) FILTER(WHERE operation='release') releases,
   bool_and(member_id=a.member_id AND grant_id=a.grant_id AND quantity=1 AND result_id=r.id
    AND operation IN ('reserve','consume','release')) valid
  FROM synthetic_entitlement_events WHERE reservation_id=r.id
 ) f ON true WHERE u.allocation_id=a.id;
 SELECT * INTO e FROM review_time_entries WHERE allocation_id=a.id;
 IF facts.n<>a.ceiling OR facts.valid IS DISTINCT FROM true
 OR (a.state IN ('allocated','begun','needs_reconciliation') AND (facts.held<>a.ceiling OR e.id IS NOT NULL))
 OR (a.state='cancelled' AND (facts.returned<>a.ceiling OR e.id IS NOT NULL))
 OR (a.state='completed' AND (e.id IS NULL OR e.actor_id<>a.begun_by OR e.grant_id<>a.begun_grant_id OR facts.used<>e.review_minutes+e.preparation_minutes OR facts.returned<>a.ceiling-facts.used))
 OR (a.state='completed' AND a.source_unavailable_at IS NULL AND NOT EXISTS(
  SELECT 1 FROM private_sample_feedback f WHERE f.id=e.feedback_id AND f.submission_id=a.submission_id
   AND f.reviewer_id=e.actor_id AND f.draft_revision=e.draft_revision
   AND f.publication_operation_id=e.publication_operation_id AND f.published_at IS NOT NULL))
 THEN RAISE EXCEPTION 'Review time allocation and unit outcomes must agree'; END IF;
END $$;
CREATE OR REPLACE FUNCTION check_review_time_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='review_time_allocations' THEN
  PERFORM assert_review_time_allocation(NEW.id);
 ELSE
  PERFORM assert_review_time_allocation(NEW.allocation_id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_allocation_consistency ON review_time_allocations;
CREATE CONSTRAINT TRIGGER review_time_allocation_consistency AFTER INSERT OR UPDATE ON review_time_allocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_review_time_allocation();
DROP TRIGGER IF EXISTS review_time_unit_consistency ON review_time_units;
CREATE CONSTRAINT TRIGGER review_time_unit_consistency AFTER INSERT ON review_time_units
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_review_time_allocation();
DROP TRIGGER IF EXISTS review_time_entry_consistency ON review_time_entries;
CREATE CONSTRAINT TRIGGER review_time_entry_consistency AFTER INSERT ON review_time_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_review_time_allocation();

CREATE OR REPLACE FUNCTION check_review_time_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation uuid;
BEGIN
 SELECT allocation_id INTO allocation FROM review_time_units WHERE reservation_id=NEW.id;
 IF allocation IS NOT NULL THEN PERFORM assert_review_time_allocation(allocation); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_reservation_consistency ON synthetic_entitlement_reservations;
CREATE CONSTRAINT TRIGGER review_time_reservation_consistency AFTER UPDATE ON synthetic_entitlement_reservations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_review_time_reservation();


-- Shared actor exclusion protects both writers, including pre-existing support
-- insert paths. Applications acquire this same lock before workspace locks.
CREATE OR REPLACE FUNCTION guard_private_effort_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; work_start timestamptz; work_end timestamptz; prep_start timestamptz; prep_end timestamptz;
BEGIN
 actor=NEW.actor_id;
 work_start=CASE WHEN TG_TABLE_NAME='support_time_entries' THEN (to_jsonb(NEW)->>'support_start')::timestamptz ELSE (to_jsonb(NEW)->>'review_start')::timestamptz END;
 work_end=CASE WHEN TG_TABLE_NAME='support_time_entries' THEN (to_jsonb(NEW)->>'support_end')::timestamptz ELSE (to_jsonb(NEW)->>'review_end')::timestamptz END;
 prep_start=NEW.preparation_start; prep_end=NEW.preparation_end;
 PERFORM pg_advisory_xact_lock(44154,hashtext(actor::text));
 IF EXISTS(
  SELECT 1 FROM (
   SELECT support_start AS starts,support_end AS ends,preparation_start AS ps,preparation_end AS pe FROM support_time_entries WHERE actor_id=actor
   UNION ALL
   SELECT review_start,review_end,preparation_start,preparation_end FROM review_time_entries WHERE actor_id=actor
  ) prior WHERE tstzrange(prior.starts,prior.ends,'[)') && tstzrange(work_start,work_end,'[)')
   OR (prep_start IS NOT NULL AND tstzrange(prior.starts,prior.ends,'[)') && tstzrange(prep_start,prep_end,'[)'))
   OR (prior.ps IS NOT NULL AND tstzrange(prior.ps,prior.pe,'[)') && tstzrange(work_start,work_end,'[)'))
   OR (prior.ps IS NOT NULL AND prep_start IS NOT NULL AND tstzrange(prior.ps,prior.pe,'[)') && tstzrange(prep_start,prep_end,'[)'))
 ) THEN RAISE EXCEPTION 'Private effort intervals conflict'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_effort_overlap_guard ON support_time_entries;
CREATE TRIGGER private_effort_overlap_guard BEFORE INSERT ON support_time_entries FOR EACH ROW EXECUTE FUNCTION guard_private_effort_overlap();
DROP TRIGGER IF EXISTS private_effort_overlap_guard ON review_time_entries;
CREATE TRIGGER private_effort_overlap_guard BEFORE INSERT ON review_time_entries FOR EACH ROW EXECUTE FUNCTION guard_private_effort_overlap();

CREATE OR REPLACE FUNCTION preserve_review_time_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM review_time_allocations WHERE id=OLD.allocation_id;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=a.member_id)
   AND EXISTS(SELECT 1 FROM workspaces WHERE id=a.workspace_id AND deleting_at IS NULL)
  THEN RAISE EXCEPTION 'Review accounting history requires owner erasure'; END IF;
  RETURN OLD;
 END IF;
 -- Erasing a private source removes the feedback link without rewriting effort.
 IF TG_TABLE_NAME='review_time_entries'
  AND to_jsonb(NEW)-'feedback_id'=to_jsonb(OLD)-'feedback_id'
  AND to_jsonb(NEW)->'feedback_id'='null'::jsonb AND a.source_unavailable_at IS NOT NULL
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Review accounting record is immutable';
END $$;
DROP TRIGGER IF EXISTS review_time_units_immutable ON review_time_units;
CREATE TRIGGER review_time_units_immutable BEFORE UPDATE OR DELETE ON review_time_units FOR EACH ROW EXECUTE FUNCTION preserve_review_time_child();
DROP TRIGGER IF EXISTS review_time_entries_immutable ON review_time_entries;
CREATE TRIGGER review_time_entries_immutable BEFORE UPDATE OR DELETE ON review_time_entries FOR EACH ROW EXECUTE FUNCTION preserve_review_time_child();
DROP TRIGGER IF EXISTS review_time_events_immutable ON review_time_events;
CREATE TRIGGER review_time_events_immutable BEFORE UPDATE OR DELETE ON review_time_events FOR EACH ROW EXECUTE FUNCTION preserve_review_time_child();
DROP TRIGGER IF EXISTS review_time_grants_immutable ON review_time_grants;
CREATE TRIGGER review_time_grants_immutable BEFORE UPDATE ON review_time_grants FOR EACH ROW EXECUTE FUNCTION preserve_support_grant();
DROP TRIGGER IF EXISTS review_time_grants_removal ON review_time_grants;
CREATE TRIGGER review_time_grants_removal BEFORE DELETE ON review_time_grants FOR EACH ROW EXECUTE FUNCTION preserve_review_time_child();

-- An old unbilled publication cannot strand a hold or impersonate settlement.
CREATE OR REPLACE FUNCTION guard_allocated_feedback_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; e record;
BEGIN
 IF NEW.published_at IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.published_at IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO a FROM review_time_allocations WHERE source_key=NEW.submission_id
  AND state IN ('allocated','begun','needs_reconciliation') FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO e FROM review_time_entries WHERE allocation_id=a.id;
 IF a.state<>'begun' OR a.source_unavailable_at IS NOT NULL OR e.id IS NULL
  OR e.feedback_id IS DISTINCT FROM NEW.id OR e.actor_id<>NEW.reviewer_id
  OR e.draft_revision<>NEW.draft_revision OR e.publication_operation_id IS DISTINCT FROM NEW.publication_operation_id
  OR NOT review_time_authorized(a.id,e.actor_id,e.grant_id)
 THEN RAISE EXCEPTION 'Allocated feedback requires atomic review settlement'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS allocated_feedback_publication_guard ON private_sample_feedback;
CREATE TRIGGER allocated_feedback_publication_guard BEFORE INSERT OR UPDATE ON private_sample_feedback
 FOR EACH ROW EXECUTE FUNCTION guard_allocated_feedback_publication();

CREATE OR REPLACE FUNCTION release_synthetic_reservation_balance(
 p_reservation uuid,p_member uuid,p_at timestamptz,p_job uuid,p_support uuid,p_review uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_row record; linked_job uuid; linked_support uuid; linked_review uuid; effective_at timestamptz;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) OR (num_nonnulls(p_job,p_support,p_review)>1) THEN RAISE EXCEPTION 'Invalid release authority'; END IF;
 SELECT r.grant_id,r.quantity,r.state,g.expires_at,g.expired_at INTO current_row
 FROM synthetic_entitlement_reservations r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
 WHERE r.id=p_reservation AND g.member_id=p_member
 AND NOT EXISTS(SELECT 1 FROM synthetic_slot_holds h WHERE h.reservation_id=r.id) FOR UPDATE OF r,g;
 IF NOT FOUND OR current_row.state<>'reserved' THEN RAISE EXCEPTION 'Reservation unavailable'; END IF;
 SELECT job_id INTO linked_job FROM local_ai_test_unit_jobs WHERE reservation_id=p_reservation;
 SELECT allocation_id INTO linked_support FROM support_time_units WHERE reservation_id=p_reservation;
 SELECT allocation_id INTO linked_review FROM review_time_units WHERE reservation_id=p_reservation;
 IF linked_job IS DISTINCT FROM p_job OR linked_support IS DISTINCT FROM p_support OR linked_review IS DISTINCT FROM p_review THEN RAISE EXCEPTION 'Reservation belongs to a protected operation'; END IF;
 IF p_job IS NOT NULL AND NOT EXISTS(SELECT 1 FROM adapter_jobs WHERE id=p_job AND member_id=p_member AND status='pending' AND attempt_count=0)
 THEN RAISE EXCEPTION 'Dispatched local request remains held'; END IF;
 IF p_support IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM support_time_allocations a JOIN support_time_units u ON u.allocation_id=a.id
  LEFT JOIN support_time_entries e ON e.allocation_id=a.id
  WHERE a.id=p_support AND a.member_id=p_member AND a.grant_id=current_row.grant_id AND u.reservation_id=p_reservation
   AND (a.state='allocated' OR (a.state='begun' AND e.id IS NOT NULL AND u.ordinal>e.support_minutes+e.preparation_minutes)))
 THEN RAISE EXCEPTION 'Started support without a known completion remains held'; END IF;
 IF p_review IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM review_time_allocations a JOIN review_time_units u ON u.allocation_id=a.id
  LEFT JOIN review_time_entries e ON e.allocation_id=a.id
  WHERE a.id=p_review AND a.member_id=p_member AND a.grant_id=current_row.grant_id AND u.reservation_id=p_reservation
   AND (a.state='allocated' OR (a.state='begun' AND e.id IS NOT NULL AND u.ordinal>e.review_minutes+e.preparation_minutes)))
 THEN RAISE EXCEPTION 'Started review without a known completion remains held'; END IF;
 effective_at=CASE WHEN p_support IS NOT NULL OR p_review IS NOT NULL THEN clock_timestamp() ELSE p_at END;
 IF current_row.expired_at IS NOT NULL OR effective_at>=current_row.expires_at THEN
  UPDATE synthetic_entitlement_grants SET reserved=reserved-current_row.quantity,expired=expired+current_row.quantity WHERE id=current_row.grant_id;
 ELSE
  UPDATE synthetic_entitlement_grants SET reserved=reserved-current_row.quantity,available=available+current_row.quantity WHERE id=current_row.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=p_reservation;
END $$;

-- Old callers cannot release a protected review reservation through an overload.
CREATE OR REPLACE FUNCTION release_synthetic_reservation_balance(
 p_reservation uuid,p_member uuid,p_at timestamptz,p_job uuid,p_support uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM release_synthetic_reservation_balance(p_reservation,p_member,p_at,p_job,p_support,NULL); END $$;

CREATE OR REPLACE FUNCTION stop_private_review_allocations(p_evidence uuid,p_erasing boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; unit record; event_key text; fingerprint text;
BEGIN
 FOR a IN SELECT * FROM review_time_allocations WHERE evidence_id=p_evidence ORDER BY id FOR UPDATE LOOP
  -- Owner erasure cascades its ledger and metadata rather than fabricating a
  -- member-visible release after the account no longer exists.
  IF NOT EXISTS(SELECT 1 FROM learners WHERE id=a.member_id)
   OR NOT EXISTS(SELECT 1 FROM workspaces WHERE id=a.workspace_id AND deleting_at IS NULL) THEN CONTINUE; END IF;
  IF a.state='allocated' THEN
   FOR unit IN SELECT u.ordinal,u.reservation_id,r.grant_id FROM review_time_units u
    JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id ORDER BY u.ordinal LOOP
    PERFORM release_synthetic_reservation_balance(unit.reservation_id,a.member_id,clock_timestamp(),NULL,NULL,a.id);
    event_key='review-time:'||a.id::text||':unit:'||unit.ordinal::text||':release';
    fingerprint=encode(sha256(convert_to(format('{"operation":"release","memberId":"%s","reservationId":"%s"}',a.member_id,unit.reservation_id),'UTF8')),'hex');
    INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
    VALUES(gen_random_uuid(),a.member_id,unit.grant_id,unit.reservation_id,'release',1,event_key,fingerprint,unit.reservation_id);
   END LOOP;
   UPDATE review_time_allocations SET state='cancelled',settled_at=clock_timestamp() WHERE id=a.id;
   INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action)
    VALUES(gen_random_uuid(),a.id,a.member_id,a.member_id,'withdrawn');
  ELSIF a.state='begun' THEN
   UPDATE review_time_allocations SET state='needs_reconciliation' WHERE id=a.id;
   INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action)
    VALUES(gen_random_uuid(),a.id,a.member_id,a.member_id,'needs-reconciliation');
  END IF;
  IF p_erasing AND a.source_unavailable_at IS NULL THEN
   UPDATE review_time_allocations SET source_unavailable_at=clock_timestamp() WHERE id=a.id;
   INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action)
    VALUES(gen_random_uuid(),a.id,a.member_id,a.member_id,'source-erased');
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION withdraw_private_review_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.private_review_allowed AND NOT NEW.private_review_allowed)
  OR (OLD.quarantine_state<>'deleting' AND NEW.quarantine_state='deleting') THEN
  PERFORM stop_private_review_allocations(NEW.id,NEW.quarantine_state='deleting');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_time_source_withdrawal ON evidence_objects;
CREATE TRIGGER review_time_source_withdrawal AFTER UPDATE OF private_review_allowed,quarantine_state ON evidence_objects
 FOR EACH ROW EXECUTE FUNCTION withdraw_private_review_time();
CREATE OR REPLACE FUNCTION guard_private_review_source_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.owner_principal_id)
  AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND deleting_at IS NULL)
  AND EXISTS(SELECT 1 FROM review_time_allocations WHERE evidence_id=OLD.id AND source_unavailable_at IS NULL)
 THEN RAISE EXCEPTION 'Review source erasure must first invalidate its allocations'; END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS review_time_source_delete_guard ON evidence_objects;
CREATE TRIGGER review_time_source_delete_guard BEFORE DELETE ON evidence_objects
 FOR EACH ROW EXECUTE FUNCTION guard_private_review_source_delete();

INSERT INTO schema_migrations(version) VALUES(58) ON CONFLICT DO NOTHING;
COMMIT;
