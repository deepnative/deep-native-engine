BEGIN;
-- Only new deliberately confirmed browser operations produce receipts. No
-- legacy grant/revocation, staff role or accounting quantity is backfilled.
CREATE TABLE IF NOT EXISTS support_time_grant_revocations (
 id uuid PRIMARY KEY,
 administrator_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 allocation_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('revoked','unchanged')),
 observed_revoked_at timestamptz NOT NULL CHECK(isfinite(observed_revoked_at)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
 UNIQUE(administrator_id,operation_id),
 FOREIGN KEY(grant_id,allocation_id) REFERENCES support_time_grants(id,allocation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS support_time_grant_revocations_allocation_idx ON support_time_grant_revocations(allocation_id);
CREATE INDEX IF NOT EXISTS support_time_grant_admin_history_idx ON support_time_grants(granted_by,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS support_time_grant_revocations_immutable ON support_time_grant_revocations;
CREATE TRIGGER support_time_grant_revocations_immutable BEFORE UPDATE OR DELETE ON support_time_grant_revocations
 FOR EACH ROW EXECUTE FUNCTION preserve_support_time_child();
INSERT INTO schema_migrations(version) VALUES(71) ON CONFLICT DO NOTHING;
COMMIT;
