BEGIN;
CREATE TABLE IF NOT EXISTS private_event_inventory (
 event_id text NOT NULL CHECK(event_id ~ '^[a-z][a-z0-9-]{0,79}$'),
 event_version integer NOT NULL CHECK(event_version BETWEEN 1 AND 1000000),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 1000 AND length(btrim(title))>0),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 100),
 PRIMARY KEY(event_id,event_version),
 UNIQUE(event_id,event_version,capacity),
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND ends_at>starts_at)
);
CREATE OR REPLACE FUNCTION preserve_private_event_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Private event inventory is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_inventory_immutable ON private_event_inventory;
CREATE TRIGGER private_event_inventory_immutable BEFORE UPDATE ON private_event_inventory
 FOR EACH ROW EXECUTE FUNCTION preserve_private_event_inventory();

CREATE TABLE IF NOT EXISTS private_event_enrollments (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 event_id text NOT NULL,
 event_version integer NOT NULL,
 capacity integer NOT NULL,
 seat_number integer NOT NULL CHECK(seat_number BETWEEN 1 AND capacity),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(event_id,event_version,capacity)
  REFERENCES private_event_inventory(event_id,event_version,capacity),
 CHECK(isfinite(created_at)),
 CHECK(withdrawn_at IS NULL OR (isfinite(withdrawn_at) AND withdrawn_at>=created_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS private_event_active_owner_idx
 ON private_event_enrollments(member_id,event_id,event_version) WHERE withdrawn_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS private_event_active_seat_idx
 ON private_event_enrollments(event_id,event_version,seat_number) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS private_event_owned_history_idx
 ON private_event_enrollments(member_id,id);
CREATE OR REPLACE FUNCTION preserve_private_event_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD)-'withdrawn_at')
    OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
  RAISE EXCEPTION 'Private event enrollment identity and withdrawal are immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_enrollment_immutable ON private_event_enrollments;
CREATE TRIGGER private_event_enrollment_immutable BEFORE UPDATE ON private_event_enrollments
 FOR EACH ROW EXECUTE FUNCTION preserve_private_event_enrollment();
INSERT INTO schema_migrations(version) VALUES(57) ON CONFLICT DO NOTHING;
COMMIT;
