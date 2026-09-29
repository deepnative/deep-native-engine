BEGIN;
CREATE TABLE IF NOT EXISTS synthetic_entitlement_settlements (
 -- The settlement's identifier is also its consume event's identifier. The
 -- deferred reference requires that event to exist when the transaction commits.
 id uuid PRIMARY KEY REFERENCES synthetic_entitlement_events(id)
   ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 grant_id uuid NOT NULL REFERENCES synthetic_entitlement_grants(id) ON DELETE CASCADE,
 reservation_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_reservations(id) ON DELETE CASCADE,
 completion_ref text NOT NULL UNIQUE
   CHECK(completion_ref ~ '^synthetic:[A-Za-z0-9][A-Za-z0-9._-]{0,109}$'),
 category text NOT NULL CHECK(category IN ('review_minutes','support_minutes','study_requests')),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 delivered_minutes integer,
 preparation_minutes integer,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((category='study_requests' AND quantity=1 AND
        delivered_minutes IS NULL AND preparation_minutes IS NULL) OR
       (category IN ('review_minutes','support_minutes') AND
        delivered_minutes IS NOT NULL AND preparation_minutes IS NOT NULL AND
        delivered_minutes>0 AND preparation_minutes>=0 AND
        delivered_minutes+preparation_minutes=quantity))
);
CREATE INDEX IF NOT EXISTS synthetic_entitlement_settlements_member_idx
 ON synthetic_entitlement_settlements(member_id,created_at);
DROP TRIGGER IF EXISTS synthetic_entitlement_settlements_immutable
 ON synthetic_entitlement_settlements;
CREATE TRIGGER synthetic_entitlement_settlements_immutable
 BEFORE UPDATE OR DELETE ON synthetic_entitlement_settlements
 FOR EACH ROW EXECUTE FUNCTION reject_synthetic_entitlement_event_mutation();
INSERT INTO schema_migrations(version) VALUES(44) ON CONFLICT DO NOTHING;
COMMIT;
