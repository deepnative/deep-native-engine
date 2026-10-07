BEGIN;
CREATE TABLE IF NOT EXISTS private_event_attendance_permissions (
 id uuid PRIMARY KEY,
 registration_id uuid NOT NULL REFERENCES private_event_enrollments(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 administrator_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 withdrawn_at timestamptz CHECK(withdrawn_at IS NULL OR isfinite(withdrawn_at)),
 CHECK(expires_at>starts_at AND expires_at>created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS private_event_attendance_one_permission
 ON private_event_attendance_permissions(registration_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS private_event_attendance_permission_owner
 ON private_event_attendance_permissions(member_id,created_at,id);

CREATE OR REPLACE FUNCTION guard_private_event_attendance_permission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed timestamptz;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'withdrawn_at'-'administrator_id') IS DISTINCT FROM (to_jsonb(OLD)-'withdrawn_at'-'administrator_id')
   OR (NEW.administrator_id IS DISTINCT FROM OLD.administrator_id AND NOT
    (NEW.administrator_id IS NULL AND OLD.administrator_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.administrator_id)))
   OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
  THEN RAISE EXCEPTION 'Private attendance permission is immutable'; END IF;
  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
   IF NEW.withdrawn_at IS NULL THEN RAISE EXCEPTION 'Private attendance withdrawal is irreversible'; END IF;
   NEW.withdrawn_at=clock_timestamp();
  END IF;
  RETURN NEW;
 END IF;
 observed=clock_timestamp(); NEW.created_at=observed;
 IF NEW.withdrawn_at IS NOT NULL OR NEW.expires_at>observed+interval '1 hour' OR NOT EXISTS(
  SELECT 1 FROM private_event_enrollments e JOIN private_event_inventory i USING(event_id,event_version)
   JOIN private_event_cancellation_state c USING(event_id,event_version)
   JOIN workspaces w ON w.id=e.workspace_id AND w.owner_principal_id=e.member_id
   JOIN principals m ON m.id=e.member_id JOIN principals a ON a.id=NEW.administrator_id
   JOIN staff_profiles s ON s.principal_id=a.id
  WHERE e.id=NEW.registration_id AND e.member_id=NEW.member_id AND e.workspace_id=NEW.workspace_id
   AND e.withdrawn_at IS NULL AND c.cancellation_id IS NULL AND w.deleting_at IS NULL
   AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>observed
   AND a.kind='staff' AND a.revoked_at IS NULL AND a.expires_at>observed AND s.role='platform_admin'
   AND NEW.starts_at>=i.starts_at AND NEW.expires_at<=i.ends_at
   AND NEW.expires_at<=m.expires_at AND NEW.expires_at<=a.expires_at AND NEW.expires_at>observed
 ) THEN RAISE EXCEPTION 'Exact current private attendance permission required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_attendance_permission_guard ON private_event_attendance_permissions;
CREATE TRIGGER private_event_attendance_permission_guard BEFORE INSERT OR UPDATE ON private_event_attendance_permissions
 FOR EACH ROW EXECUTE FUNCTION guard_private_event_attendance_permission();

CREATE TABLE IF NOT EXISTS private_event_attendance_observations (
 id uuid PRIMARY KEY,
 permission_id uuid NOT NULL REFERENCES private_event_attendance_permissions(id) ON DELETE CASCADE,
 registration_id uuid NOT NULL UNIQUE REFERENCES private_event_enrollments(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 administrator_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at))
);
CREATE OR REPLACE FUNCTION guard_private_event_attendance_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'administrator_id') IS DISTINCT FROM (to_jsonb(OLD)-'administrator_id')
   OR NEW.administrator_id IS NOT NULL OR OLD.administrator_id IS NULL
   OR EXISTS(SELECT 1 FROM principals WHERE id=OLD.administrator_id)
  THEN RAISE EXCEPTION 'Private attendance observation is immutable'; END IF;
  RETURN NEW;
 END IF;
 NEW.recorded_at=clock_timestamp();
 IF NOT EXISTS(
  SELECT 1 FROM private_event_attendance_permissions p JOIN private_event_enrollments e ON e.id=p.registration_id
   JOIN private_event_inventory i USING(event_id,event_version)
   JOIN private_event_cancellation_state c USING(event_id,event_version)
   JOIN workspaces w ON w.id=e.workspace_id AND w.owner_principal_id=e.member_id
   JOIN principals m ON m.id=e.member_id JOIN principals a ON a.id=p.administrator_id
   JOIN staff_profiles s ON s.principal_id=a.id
  WHERE p.id=NEW.permission_id AND e.id=NEW.registration_id AND p.member_id=NEW.member_id AND p.workspace_id=NEW.workspace_id
   AND p.administrator_id=NEW.administrator_id AND p.withdrawn_at IS NULL AND e.withdrawn_at IS NULL
   AND c.cancellation_id IS NULL AND w.deleting_at IS NULL
   AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>NEW.recorded_at
   AND a.kind='staff' AND a.revoked_at IS NULL AND a.expires_at>NEW.recorded_at AND s.role='platform_admin'
   AND p.starts_at<=NEW.recorded_at AND NEW.recorded_at<p.expires_at
   AND i.starts_at<=NEW.recorded_at AND NEW.recorded_at<i.ends_at
 ) THEN RAISE EXCEPTION 'Exact current observation window and permission required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_attendance_observation_guard ON private_event_attendance_observations;
CREATE TRIGGER private_event_attendance_observation_guard BEFORE INSERT OR UPDATE ON private_event_attendance_observations
 FOR EACH ROW EXECUTE FUNCTION guard_private_event_attendance_observation();

-- Erasure retains only an anonymous global reservation. Explicit removal clears
-- deleted permission/observation references but retains a structural operation
-- receipt for current-owner original-key recovery; it contains no observation.
CREATE TABLE IF NOT EXISTS private_event_attendance_operations (
 operation_id uuid PRIMARY KEY,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
 registration_id uuid REFERENCES private_event_enrollments(id) ON DELETE SET NULL,
 kind text CHECK(kind IN ('permit','withdraw','observe','remove')),
 instruction_hash text CHECK(instruction_hash ~ '^[a-f0-9]{64}$'),
 permission_id uuid REFERENCES private_event_attendance_permissions(id) ON DELETE SET NULL,
 observation_id uuid REFERENCES private_event_attendance_observations(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 CHECK((actor_id IS NULL AND workspace_id IS NULL AND registration_id IS NULL AND kind IS NULL AND instruction_hash IS NULL AND permission_id IS NULL AND observation_id IS NULL)
  OR (actor_id IS NOT NULL AND workspace_id IS NOT NULL AND registration_id IS NOT NULL AND kind IS NOT NULL AND instruction_hash IS NOT NULL))
);
CREATE OR REPLACE FUNCTION guard_private_event_attendance_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Private attendance operation key is reserved'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'Private attendance operation is immutable'; END IF;
  IF (NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id))
   OR (NEW.workspace_id IS NULL AND OLD.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id))
   OR (NEW.registration_id IS NULL AND OLD.registration_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM private_event_enrollments WHERE id=OLD.registration_id))
  THEN
   NEW.actor_id=NULL; NEW.workspace_id=NULL; NEW.registration_id=NULL; NEW.kind=NULL; NEW.instruction_hash=NULL; NEW.permission_id=NULL; NEW.observation_id=NULL;
   RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'permission_id'-'observation_id') IS DISTINCT FROM (to_jsonb(OLD)-'permission_id'-'observation_id')
   OR (NEW.permission_id IS DISTINCT FROM OLD.permission_id AND NOT (NEW.permission_id IS NULL AND NOT EXISTS(SELECT 1 FROM private_event_attendance_permissions WHERE id=OLD.permission_id)))
   OR (NEW.observation_id IS DISTINCT FROM OLD.observation_id AND NOT (NEW.observation_id IS NULL AND NOT EXISTS(SELECT 1 FROM private_event_attendance_observations WHERE id=OLD.observation_id)))
  THEN RAISE EXCEPTION 'Private attendance operation is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM principals a JOIN workspaces w ON w.id=NEW.workspace_id JOIN private_event_enrollments e ON e.id=NEW.registration_id
  WHERE a.id=NEW.actor_id AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND w.deleting_at IS NULL
   AND e.workspace_id=w.id AND e.member_id=w.owner_principal_id
   AND ((NEW.kind IN ('permit','withdraw','remove') AND a.kind='member' AND w.owner_principal_id=a.id)
    OR (NEW.kind='observe' AND a.kind='staff' AND EXISTS(SELECT 1 FROM staff_profiles s WHERE s.principal_id=a.id AND s.role='platform_admin'))))
 THEN RAISE EXCEPTION 'Private attendance operation authority required'; END IF;
 IF NEW.kind IN ('permit','withdraw') AND (NEW.observation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM private_event_attendance_permissions p
   WHERE p.id=NEW.permission_id AND p.registration_id=NEW.registration_id
    AND p.workspace_id=NEW.workspace_id AND p.member_id=NEW.actor_id
 )) THEN RAISE EXCEPTION 'Exact private attendance operation source required'; END IF;
 IF NEW.kind='observe' AND NOT EXISTS(
  SELECT 1 FROM private_event_attendance_permissions p
   JOIN private_event_attendance_observations o ON o.permission_id=p.id
  WHERE p.id=NEW.permission_id AND o.id=NEW.observation_id
   AND p.registration_id=NEW.registration_id AND o.registration_id=NEW.registration_id
   AND p.workspace_id=NEW.workspace_id AND o.workspace_id=NEW.workspace_id
   AND p.administrator_id=NEW.actor_id AND o.administrator_id=NEW.actor_id
 ) THEN RAISE EXCEPTION 'Exact private attendance operation source required'; END IF;
 IF NEW.kind='remove' AND (NEW.permission_id IS NOT NULL OR NEW.observation_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Exact private attendance operation source required'; END IF;
 NEW.created_at=clock_timestamp();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_attendance_operation_guard ON private_event_attendance_operations;
CREATE TRIGGER private_event_attendance_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON private_event_attendance_operations
 FOR EACH ROW EXECUTE FUNCTION guard_private_event_attendance_operation();
INSERT INTO schema_migrations(version) VALUES(66) ON CONFLICT DO NOTHING;
COMMIT;
