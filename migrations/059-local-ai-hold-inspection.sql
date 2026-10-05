BEGIN;
-- Purpose-specific metadata access only; legacy staff/jobs receive no grants.
CREATE UNIQUE INDEX IF NOT EXISTS local_ai_test_unit_jobs_owned_idx
 ON local_ai_test_unit_jobs(job_id,member_id);
CREATE TABLE IF NOT EXISTS local_ai_hold_inspection_grants (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 staff_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 purpose text NOT NULL DEFAULT 'local-ai-hold-inspection-test-v1'
  CHECK(purpose='local-ai-hold-inspection-test-v1'),
 starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 revoked_at timestamptz CHECK(revoked_at IS NULL OR isfinite(revoked_at)),
 granted_by uuid REFERENCES principals(id) ON DELETE SET NULL,
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>starts_at),
 FOREIGN KEY(job_id,member_id) REFERENCES local_ai_test_unit_jobs(job_id,member_id) ON DELETE CASCADE,
 UNIQUE(granted_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS local_ai_hold_inspection_staff_idx
 ON local_ai_hold_inspection_grants(staff_id,job_id,expires_at,id)
 WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS local_ai_hold_inspection_events (
 id uuid PRIMARY KEY,
 grant_id uuid NOT NULL REFERENCES local_ai_hold_inspection_grants(id) ON DELETE CASCADE,
 job_id uuid NOT NULL,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN ('grant-created','grant-revoked')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(job_id,member_id) REFERENCES local_ai_test_unit_jobs(job_id,member_id) ON DELETE CASCADE,
 UNIQUE(grant_id,action)
);
CREATE OR REPLACE FUNCTION guard_local_ai_hold_inspection_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id)
   AND EXISTS(SELECT 1 FROM principals WHERE id=OLD.staff_id)
  THEN RAISE EXCEPTION 'Inspection grant requires owner or staff erasure'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['revoked_at','granted_by']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['revoked_at','granted_by'])
   OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
   OR (NEW.granted_by IS DISTINCT FROM OLD.granted_by AND NOT
      (NEW.granted_by IS NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.granted_by)))
  THEN RAISE EXCEPTION 'Inspection grant identity is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
   WHERE p.id=NEW.staff_id AND p.kind='staff' AND s.role='operator'
    AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
   WHERE p.id=NEW.granted_by AND p.kind='staff' AND s.role='platform_admin'
    AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp())
 OR NEW.staff_id=NEW.granted_by
 THEN RAISE EXCEPTION 'Inspection grant authority unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_ai_hold_inspection_grant_guard ON local_ai_hold_inspection_grants;
CREATE TRIGGER local_ai_hold_inspection_grant_guard BEFORE INSERT OR UPDATE OR DELETE
 ON local_ai_hold_inspection_grants FOR EACH ROW EXECUTE FUNCTION guard_local_ai_hold_inspection_grant();
CREATE OR REPLACE FUNCTION guard_local_ai_hold_inspection_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id)
   AND EXISTS(SELECT 1 FROM local_ai_hold_inspection_grants WHERE id=OLD.grant_id)
  THEN RAISE EXCEPTION 'Inspection audit requires erasure'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'actor_id') IS DISTINCT FROM (to_jsonb(OLD)-'actor_id')
   OR NOT (NEW.actor_id IS NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id))
  THEN RAISE EXCEPTION 'Inspection audit is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM local_ai_hold_inspection_grants g
   WHERE g.id=NEW.grant_id AND g.job_id=NEW.job_id AND g.member_id=NEW.member_id
    AND ((NEW.action='grant-created' AND g.granted_by=NEW.actor_id AND g.revoked_at IS NULL)
     OR (NEW.action='grant-revoked' AND g.revoked_at IS NOT NULL)))
 OR NOT EXISTS(SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
   WHERE p.id=NEW.actor_id AND p.kind='staff' AND s.role='platform_admin'
    AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Inspection audit authority unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_ai_hold_inspection_event_guard ON local_ai_hold_inspection_events;
CREATE TRIGGER local_ai_hold_inspection_event_guard BEFORE INSERT OR UPDATE OR DELETE
 ON local_ai_hold_inspection_events FOR EACH ROW EXECUTE FUNCTION guard_local_ai_hold_inspection_event();
COMMIT;
