BEGIN;
-- Cancellation is global exact-version state, independent of attendee erasure.
CREATE TABLE IF NOT EXISTS private_event_cancellations (
 id uuid PRIMARY KEY,
 event_id text NOT NULL,
 event_version integer NOT NULL,
 cancelled_at timestamptz NOT NULL CHECK(isfinite(cancelled_at)),
 FOREIGN KEY(event_id,event_version) REFERENCES private_event_inventory(event_id,event_version),
 UNIQUE(event_id,event_version),
 UNIQUE(id,event_id,event_version)
);
CREATE TABLE IF NOT EXISTS private_event_cancellation_state (
 event_id text NOT NULL,
 event_version integer NOT NULL,
 cancellation_id uuid,
 PRIMARY KEY(event_id,event_version),
 FOREIGN KEY(event_id,event_version) REFERENCES private_event_inventory(event_id,event_version) ON DELETE CASCADE,
 FOREIGN KEY(cancellation_id,event_id,event_version)
  REFERENCES private_event_cancellations(id,event_id,event_version) DEFERRABLE INITIALLY DEFERRED
);
-- Keep keys reserved after administrator identity erasure; no attendee metadata.
CREATE TABLE IF NOT EXISTS private_event_cancellation_operations (
 idempotency_key uuid PRIMARY KEY,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 event_id text NOT NULL,
 event_version integer NOT NULL,
 cancellation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('cancelled','already-cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 FOREIGN KEY(cancellation_id,event_id,event_version)
  REFERENCES private_event_cancellations(id,event_id,event_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS private_event_cancellation_creator_idx
 ON private_event_cancellation_operations(cancellation_id) WHERE action='cancelled';
CREATE INDEX IF NOT EXISTS private_event_cancellation_operations_actor_idx
 ON private_event_cancellation_operations(actor_id,idempotency_key);
CREATE OR REPLACE FUNCTION initialize_private_event_cancellation_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO private_event_cancellation_state(event_id,event_version)
 VALUES(NEW.event_id,NEW.event_version) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_cancellation_state_initialize ON private_event_inventory;
CREATE TRIGGER private_event_cancellation_state_initialize AFTER INSERT ON private_event_inventory
 FOR EACH ROW EXECUTE FUNCTION initialize_private_event_cancellation_state();
INSERT INTO private_event_cancellation_state(event_id,event_version)
 SELECT event_id,event_version FROM private_event_inventory ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION preserve_private_event_cancellation_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.cancellation_id IS NOT NULL OR EXISTS(SELECT 1 FROM private_event_inventory
   WHERE event_id=OLD.event_id AND event_version=OLD.event_version)
  THEN RAISE EXCEPTION 'Private event cancellation state is retained'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.event_id,NEW.event_version) IS DISTINCT FROM (OLD.event_id,OLD.event_version)
  OR OLD.cancellation_id IS NOT NULL OR NEW.cancellation_id IS NULL
 THEN RAISE EXCEPTION 'Private event cancellation is one way'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_cancellation_state_guard ON private_event_cancellation_state;
CREATE TRIGGER private_event_cancellation_state_guard BEFORE UPDATE OR DELETE ON private_event_cancellation_state
 FOR EACH ROW EXECUTE FUNCTION preserve_private_event_cancellation_state();
CREATE OR REPLACE FUNCTION preserve_private_event_cancellation_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Private event cancellation receipt is immutable';
END $$;
DROP TRIGGER IF EXISTS private_event_cancellation_fact_guard ON private_event_cancellations;
CREATE TRIGGER private_event_cancellation_fact_guard BEFORE UPDATE OR DELETE ON private_event_cancellations
 FOR EACH ROW EXECUTE FUNCTION preserve_private_event_cancellation_fact();

CREATE OR REPLACE FUNCTION guard_private_event_cancellation_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Private event cancellation operation is retained';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'actor_id') IS DISTINCT FROM (to_jsonb(OLD)-'actor_id')
   OR NOT (NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id))
  THEN RAISE EXCEPTION 'Private event cancellation operation is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
   WHERE p.id=NEW.actor_id AND p.kind='staff' AND s.role='platform_admin'
    AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM private_event_cancellations c
    JOIN private_event_inventory i USING(event_id,event_version)
    WHERE c.id=NEW.cancellation_id AND c.event_id=NEW.event_id AND c.event_version=NEW.event_version
     AND i.starts_at>clock_timestamp() AND c.cancelled_at<i.starts_at
     AND c.cancelled_at<=clock_timestamp())
 THEN RAISE EXCEPTION 'Private event cancellation authority unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_cancellation_operation_guard ON private_event_cancellation_operations;
CREATE TRIGGER private_event_cancellation_operation_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private_event_cancellation_operations FOR EACH ROW EXECUTE FUNCTION guard_private_event_cancellation_operation();

CREATE OR REPLACE FUNCTION check_private_event_cancellation_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_id uuid;
BEGIN
 SELECT cancellation_id INTO current_id FROM private_event_cancellation_state
  WHERE event_id=NEW.event_id AND event_version=NEW.event_version;
 IF current_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM private_event_cancellations c
    WHERE c.id=current_id AND c.event_id=NEW.event_id AND c.event_version=NEW.event_version)
   OR NOT EXISTS(SELECT 1 FROM private_event_cancellation_operations o
    WHERE o.cancellation_id=current_id AND o.event_id=NEW.event_id AND o.event_version=NEW.event_version
     AND o.action='cancelled')
  THEN RAISE EXCEPTION 'Private event cancellation requires a receipt and operation'; END IF;
 ELSIF EXISTS(SELECT 1 FROM private_event_cancellations c
  WHERE c.event_id=NEW.event_id AND c.event_version=NEW.event_version) THEN
  RAISE EXCEPTION 'Private event cancellation requires its monotonic fence';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_cancellation_state_coherence ON private_event_cancellation_state;
CREATE CONSTRAINT TRIGGER private_event_cancellation_state_coherence
 AFTER INSERT OR UPDATE ON private_event_cancellation_state DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_private_event_cancellation_coherence();
DROP TRIGGER IF EXISTS private_event_cancellation_fact_coherence ON private_event_cancellations;
CREATE CONSTRAINT TRIGGER private_event_cancellation_fact_coherence
 AFTER INSERT ON private_event_cancellations DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_private_event_cancellation_coherence();

CREATE OR REPLACE FUNCTION fence_cancelled_private_event_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_id uuid;
BEGIN
 -- Acquire the FK workspace lock before inventory, including direct legacy writers.
 -- Otherwise a direct insert could invert withdrawal's workspace -> inventory order.
 PERFORM id FROM workspaces WHERE id=NEW.workspace_id AND owner_principal_id=NEW.member_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Private event registration unavailable'; END IF;
 PERFORM event_id FROM private_event_inventory
  WHERE event_id=NEW.event_id AND event_version=NEW.event_version FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Private event registration unavailable'; END IF;
 SELECT cancellation_id INTO state_id FROM private_event_cancellation_state
  WHERE event_id=NEW.event_id AND event_version=NEW.event_version FOR UPDATE;
 IF NOT FOUND OR state_id IS NOT NULL THEN
  RAISE EXCEPTION 'Private event registration unavailable';
 END IF;
 -- The cancelled transition UPDATE makes stale RR/SERIALIZABLE snapshots fail.
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_enrollment_cancellation_fence ON private_event_enrollments;
CREATE TRIGGER private_event_enrollment_cancellation_fence BEFORE INSERT ON private_event_enrollments
 FOR EACH ROW EXECUTE FUNCTION fence_cancelled_private_event_enrollment();
INSERT INTO schema_migrations(version) VALUES(62) ON CONFLICT DO NOTHING;
COMMIT;
