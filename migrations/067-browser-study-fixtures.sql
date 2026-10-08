BEGIN;
-- An owned policy slot is retained after cancellation, expiry or withdrawal.
-- Existing grants are deliberately not backfilled with an invented issuer.
CREATE TABLE IF NOT EXISTS browser_study_fixture_requests (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 administrator_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 policy text NOT NULL CHECK(policy='browser-study-fixture-v1'),
 member_expires_at timestamptz NOT NULL CHECK(isfinite(member_expires_at)),
 administrator_expires_at timestamptz NOT NULL CHECK(isfinite(administrator_expires_at)),
 checked_at timestamptz NOT NULL CHECK(isfinite(checked_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 grant_id uuid UNIQUE REFERENCES synthetic_entitlement_grants(id),
 issued_at timestamptz CHECK(issued_at IS NULL OR isfinite(issued_at)),
 grant_expires_at timestamptz CHECK(grant_expires_at IS NULL OR isfinite(grant_expires_at)),
 withdrawn_at timestamptz CHECK(withdrawn_at IS NULL OR isfinite(withdrawn_at)),
 UNIQUE(member_id,policy),
 CHECK(expires_at>created_at AND expires_at>checked_at
   AND expires_at<=checked_at+interval '30 minutes'
   AND expires_at<=member_expires_at AND expires_at<=administrator_expires_at),
 CHECK((grant_id IS NULL AND issued_at IS NULL AND grant_expires_at IS NULL) OR
   (grant_id IS NOT NULL AND issued_at IS NOT NULL AND grant_expires_at>issued_at
    AND grant_expires_at<=expires_at AND grant_expires_at<=issued_at+interval '15 minutes'))
);
CREATE OR REPLACE FUNCTION guard_browser_study_fixture_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM principals WHERE id=OLD.member_id) THEN
   RAISE EXCEPTION 'Study fixture policy slot is retained';
  END IF;
  RETURN OLD;
 END IF;
 observed=clock_timestamp();
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'administrator_id'-'grant_id'-'issued_at'-'grant_expires_at'-'withdrawn_at')
    IS DISTINCT FROM (to_jsonb(OLD)-'administrator_id'-'grant_id'-'issued_at'-'grant_expires_at'-'withdrawn_at')
   OR (NEW.administrator_id IS DISTINCT FROM OLD.administrator_id AND NOT
     (NEW.administrator_id IS NULL AND OLD.administrator_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.administrator_id)))
   OR (OLD.grant_id IS NOT NULL AND
     (NEW.grant_id,NEW.issued_at,NEW.grant_expires_at) IS DISTINCT FROM
     (OLD.grant_id,OLD.issued_at,OLD.grant_expires_at))
   OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
  THEN RAISE EXCEPTION 'Study fixture instruction is immutable'; END IF;
  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
   IF NEW.withdrawn_at IS NULL THEN RAISE EXCEPTION 'Study fixture withdrawal is irreversible'; END IF;
   NEW.withdrawn_at=observed;
  END IF;
  IF OLD.grant_id IS NULL AND NEW.grant_id IS NOT NULL THEN
   IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM synthetic_entitlement_grants g
     JOIN synthetic_entitlement_events e ON e.grant_id=g.id
     JOIN principals a ON a.id=NEW.administrator_id
     JOIN staff_profiles s ON s.principal_id=a.id
     JOIN principals m ON m.id=NEW.member_id
     JOIN workspaces w ON w.id=NEW.workspace_id
    WHERE g.id=NEW.grant_id AND g.member_id=NEW.member_id AND g.category='study_requests'
     AND g.quantity=3 AND g.starts_at=NEW.issued_at AND g.expires_at=NEW.grant_expires_at
     AND e.operation='grant' AND e.member_id=NEW.member_id AND e.quantity=3
     AND e.idempotency_key='browser-study-fixture-grant:'||NEW.id::text
     AND a.kind='staff' AND a.revoked_at IS NULL AND a.expires_at>observed AND s.role='platform_admin'
     AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>observed
     AND w.owner_principal_id=NEW.member_id AND w.deleting_at IS NULL
     AND NEW.expires_at>observed AND NEW.member_expires_at>observed AND NEW.administrator_expires_at>observed
     AND NEW.grant_expires_at>observed AND NEW.issued_at<=observed
     AND NEW.grant_expires_at<=a.expires_at AND NEW.grant_expires_at<=m.expires_at
   ) THEN RAISE EXCEPTION 'Exact current study fixture issuance required'; END IF;
  ELSIF OLD.grant_id IS NULL AND
    (NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.grant_expires_at IS DISTINCT FROM OLD.grant_expires_at)
  THEN RAISE EXCEPTION 'Study fixture issuance linkage required'; END IF;
  RETURN NEW;
 END IF;
 NEW.created_at=observed;
 IF NEW.grant_id IS NOT NULL OR NEW.withdrawn_at IS NOT NULL OR NEW.checked_at>observed OR NOT EXISTS(
  SELECT 1 FROM principals m JOIN learners l ON l.id=m.id
   JOIN workspaces w ON w.id=NEW.workspace_id
   JOIN principals a ON a.id=NEW.administrator_id
   JOIN staff_profiles s ON s.principal_id=a.id
  WHERE m.id=NEW.member_id AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>observed
   AND a.kind='staff' AND a.revoked_at IS NULL AND a.expires_at>observed AND s.role='platform_admin'
   AND w.owner_principal_id=m.id AND w.deleting_at IS NULL
   -- PostgreSQL clocks retain microseconds; pg Date transport conservatively
   -- truncates them to milliseconds. Never round the original bound upward.
   AND NEW.member_expires_at<=m.expires_at AND m.expires_at<NEW.member_expires_at+interval '1 millisecond'
   AND NEW.administrator_expires_at<=a.expires_at AND a.expires_at<NEW.administrator_expires_at+interval '1 millisecond'
   AND NEW.expires_at>observed AND NEW.expires_at<=observed+interval '30 minutes'
 ) THEN RAISE EXCEPTION 'Exact current study fixture request required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS browser_study_fixture_request_guard ON browser_study_fixture_requests;
CREATE TRIGGER browser_study_fixture_request_guard BEFORE INSERT OR UPDATE OR DELETE ON browser_study_fixture_requests
 FOR EACH ROW EXECUTE FUNCTION guard_browser_study_fixture_request();

-- Erasure leaves only an anonymous key reservation, never an identity tracker.
CREATE TABLE IF NOT EXISTS browser_study_fixture_operations (
 operation_id uuid PRIMARY KEY,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
 request_id uuid REFERENCES browser_study_fixture_requests(id) ON DELETE SET NULL,
 kind text CHECK(kind IN ('request','issue','withdraw')),
 instruction_hash text CHECK(instruction_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 CHECK((actor_id IS NULL AND workspace_id IS NULL AND request_id IS NULL AND kind IS NULL AND instruction_hash IS NULL)
  OR (actor_id IS NOT NULL AND workspace_id IS NOT NULL AND request_id IS NOT NULL AND kind IS NOT NULL AND instruction_hash IS NOT NULL))
);
CREATE OR REPLACE FUNCTION guard_browser_study_fixture_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Study fixture operation key is reserved'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'Study fixture operation is immutable'; END IF;
  IF (NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id))
   OR (NEW.workspace_id IS NULL AND OLD.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id))
   OR (NEW.request_id IS NULL AND OLD.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM browser_study_fixture_requests WHERE id=OLD.request_id))
  THEN NEW.actor_id=NULL; NEW.workspace_id=NULL; NEW.request_id=NULL; NEW.kind=NULL; NEW.instruction_hash=NULL; RETURN NEW;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Study fixture operation is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM browser_study_fixture_requests r
   JOIN workspaces w ON w.id=r.workspace_id
   JOIN principals a ON a.id=NEW.actor_id
  WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND w.deleting_at IS NULL
   AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
   AND ((NEW.kind IN ('request','withdraw') AND a.kind='member' AND a.id=r.member_id)
    OR (NEW.kind='issue' AND a.kind='staff' AND a.id=r.administrator_id AND r.grant_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM staff_profiles s WHERE s.principal_id=a.id AND s.role='platform_admin')))
 ) THEN RAISE EXCEPTION 'Exact study fixture operation authority required'; END IF;
 NEW.created_at=clock_timestamp(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS browser_study_fixture_operation_guard ON browser_study_fixture_operations;
CREATE TRIGGER browser_study_fixture_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON browser_study_fixture_operations
 FOR EACH ROW EXECUTE FUNCTION guard_browser_study_fixture_operation();
INSERT INTO schema_migrations(version) VALUES(67) ON CONFLICT DO NOTHING;
COMMIT;
