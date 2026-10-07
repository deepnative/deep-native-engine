BEGIN;
-- This shared admission row is updated, not merely locked: stale RR/SERIALIZABLE
-- writers must fail rather than admit schedules from an old count snapshot.
CREATE TABLE IF NOT EXISTS private_event_rehearsal_admission (
 id integer PRIMARY KEY CHECK(id=1),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0)
);
INSERT INTO private_event_rehearsal_admission(id) VALUES(1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS private_event_rehearsals (
 id uuid PRIMARY KEY,
 event_id text NOT NULL UNIQUE CHECK(event_id='local-rehearsal-'||id::text),
 event_version integer NOT NULL CHECK(event_version=1),
 template_id text NOT NULL CHECK(template_id='local-registration-rehearsal'),
 template_version integer NOT NULL CHECK(template_version=1),
 template_digest text NOT NULL CHECK(template_digest ~ '^[a-f0-9]{64}$'),
 template_snapshot jsonb NOT NULL CHECK(jsonb_typeof(template_snapshot)='object'),
 scheduled_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(scheduled_at)),
 FOREIGN KEY(event_id,event_version) REFERENCES private_event_inventory(event_id,event_version),
 UNIQUE(id,event_id,event_version)
);
-- These immutable operation receipts are the scheduling audit. There is no
-- attendee list, workspace access grant, private text or invented service cost.
CREATE TABLE IF NOT EXISTS private_event_rehearsal_operations (
 idempotency_key uuid PRIMARY KEY,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 rehearsal_id uuid NOT NULL UNIQUE REFERENCES private_event_rehearsals(id),
 checked_snapshot jsonb NOT NULL CHECK(jsonb_typeof(checked_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at))
);
CREATE INDEX IF NOT EXISTS private_event_rehearsal_operations_actor_idx
 ON private_event_rehearsal_operations(actor_id,idempotency_key);
CREATE INDEX IF NOT EXISTS private_event_inventory_schedule_idx
 ON private_event_inventory(starts_at,event_id,event_version);

CREATE OR REPLACE FUNCTION guard_private_event_rehearsal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory private_event_inventory%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Private rehearsal snapshot is immutable'; END IF;
 UPDATE private_event_rehearsal_admission SET generation=generation+1 WHERE id=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Private rehearsal admission unavailable'; END IF;
 IF (SELECT count(*) FROM private_event_rehearsals r
      JOIN private_event_inventory i USING(event_id,event_version)
      WHERE i.starts_at>clock_timestamp() AND NOT EXISTS(
       SELECT 1 FROM private_event_cancellations c
       WHERE c.event_id=r.event_id AND c.event_version=r.event_version))>=20
 THEN RAISE EXCEPTION 'Private rehearsal admission unavailable'; END IF;
 SELECT * INTO inventory FROM private_event_inventory
  WHERE event_id=NEW.event_id AND event_version=NEW.event_version FOR SHARE;
 IF NOT FOUND OR inventory.capacity<>1
  OR inventory.starts_at<clock_timestamp()+interval '2 minutes'
  OR inventory.starts_at>clock_timestamp()+interval '30 days'
  OR inventory.ends_at<>inventory.starts_at+interval '1 hour'
  OR inventory.title IS DISTINCT FROM NEW.template_snapshot->>'title'
  OR NEW.scheduled_at>clock_timestamp()
 THEN RAISE EXCEPTION 'Private rehearsal snapshot unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_rehearsal_guard ON private_event_rehearsals;
CREATE TRIGGER private_event_rehearsal_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private_event_rehearsals FOR EACH ROW EXECUTE FUNCTION guard_private_event_rehearsal();

CREATE OR REPLACE FUNCTION guard_private_event_rehearsal_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Private rehearsal operation is retained'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'actor_id') IS DISTINCT FROM (to_jsonb(OLD)-'actor_id')
   OR NOT (NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id))
  THEN RAISE EXCEPTION 'Private rehearsal operation is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
  WHERE p.id=NEW.actor_id AND p.kind='staff' AND p.revoked_at IS NULL
   AND p.expires_at>clock_timestamp() AND s.role='platform_admin')
 THEN RAISE EXCEPTION 'Current private rehearsal authority required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM private_event_rehearsals r
   JOIN private_event_inventory i USING(event_id,event_version)
   WHERE r.id=NEW.rehearsal_id
    AND NEW.checked_snapshot=jsonb_build_object(
     'templateId',r.template_id,'templateVersion',r.template_version,
     'templateDigest',r.template_digest,'title',i.title,'capacity',i.capacity,
     'startsAt',to_char(i.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'endsAt',to_char(i.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
 THEN RAISE EXCEPTION 'Private rehearsal instruction conflicts'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_rehearsal_operation_guard ON private_event_rehearsal_operations;
CREATE TRIGGER private_event_rehearsal_operation_guard BEFORE INSERT OR UPDATE OR DELETE
 ON private_event_rehearsal_operations FOR EACH ROW EXECUTE FUNCTION guard_private_event_rehearsal_operation();

CREATE OR REPLACE FUNCTION check_private_event_rehearsal_coherence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private_event_rehearsal_operations WHERE rehearsal_id=NEW.id)
 THEN RAISE EXCEPTION 'Private rehearsal requires its atomic operation receipt'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_event_rehearsal_coherence ON private_event_rehearsals;
CREATE CONSTRAINT TRIGGER private_event_rehearsal_coherence AFTER INSERT
 ON private_event_rehearsals DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_private_event_rehearsal_coherence();
INSERT INTO schema_migrations(version) VALUES(63) ON CONFLICT DO NOTHING;
COMMIT;
