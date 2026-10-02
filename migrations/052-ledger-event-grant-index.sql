BEGIN;
-- Member erasure cascades through each grant. Avoid rescanning the complete
-- immutable event history for every grant; ownership and mutation guards stay.
CREATE INDEX IF NOT EXISTS synthetic_entitlement_events_grant_idx
 ON synthetic_entitlement_events(grant_id);
INSERT INTO schema_migrations(version) VALUES(52) ON CONFLICT DO NOTHING;
COMMIT;
