BEGIN;
CREATE TABLE IF NOT EXISTS synthetic_entitlement_grants (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 category text NOT NULL CHECK(category IN ('coach_minutes','review_minutes','support_minutes','mock_sessions','study_requests')),
 quantity integer NOT NULL CHECK(quantity > 0),
 available integer NOT NULL CHECK(available >= 0),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved >= 0),
 consumed integer NOT NULL DEFAULT 0 CHECK(consumed >= 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(available + reserved + consumed = quantity)
);
CREATE INDEX IF NOT EXISTS synthetic_entitlement_grants_member_idx
 ON synthetic_entitlement_grants(member_id,category);
CREATE TABLE IF NOT EXISTS synthetic_entitlement_reservations (
 id uuid PRIMARY KEY,
 grant_id uuid NOT NULL REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 quantity integer NOT NULL CHECK(quantity > 0),
 state text NOT NULL CHECK(state IN ('reserved','consumed','released')),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS synthetic_entitlement_events (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 grant_id uuid NOT NULL REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 reservation_id uuid REFERENCES synthetic_entitlement_reservations(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK(operation IN ('grant','reserve','consume','release')),
 quantity integer NOT NULL CHECK(quantity > 0),
 idempotency_key text NOT NULL UNIQUE,
 request_fingerprint text NOT NULL CHECK(length(request_fingerprint)=64),
 result_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((operation='grant' AND reservation_id IS NULL) OR
       (operation<>'grant' AND reservation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS synthetic_entitlement_events_member_idx
 ON synthetic_entitlement_events(member_id,created_at);
CREATE OR REPLACE FUNCTION reject_synthetic_entitlement_event_mutation()
RETURNS trigger AS $$
BEGIN
  -- Member removal may cascade-delete the synthetic record. All ordinary
  -- event edits and deletes while that member exists are rejected.
  IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN
    RAISE EXCEPTION 'Synthetic entitlement event history is immutable';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS synthetic_entitlement_events_immutable
 ON synthetic_entitlement_events;
CREATE TRIGGER synthetic_entitlement_events_immutable
 BEFORE UPDATE OR DELETE ON synthetic_entitlement_events
 FOR EACH ROW EXECUTE FUNCTION reject_synthetic_entitlement_event_mutation();
INSERT INTO schema_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;
COMMIT;
