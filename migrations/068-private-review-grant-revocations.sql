BEGIN;
-- Only explicitly confirmed browser revocations create operations. Existing
-- grants/revocations are untouched; no historical operation is invented.
CREATE TABLE IF NOT EXISTS review_time_grant_revocations (
 id uuid PRIMARY KEY,
 administrator_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 allocation_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('revoked','unchanged')),
 observed_revoked_at timestamptz NOT NULL CHECK(isfinite(observed_revoked_at)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
 UNIQUE(administrator_id,operation_id),
 FOREIGN KEY(grant_id,allocation_id) REFERENCES review_time_grants(id,allocation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS review_time_grant_revocations_allocation_idx ON review_time_grant_revocations(allocation_id);
CREATE INDEX IF NOT EXISTS review_time_grant_admin_history_idx ON review_time_grants(granted_by,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS review_time_grant_revocations_immutable ON review_time_grant_revocations;
CREATE TRIGGER review_time_grant_revocations_immutable BEFORE UPDATE OR DELETE ON review_time_grant_revocations
 FOR EACH ROW EXECUTE FUNCTION preserve_review_time_child();
-- Data-preserving rollback switches browser administration to recovery-only;
-- retained receipts and existing grants/accounting are never dropped.
INSERT INTO schema_migrations(version) VALUES(68) ON CONFLICT DO NOTHING;
COMMIT;
