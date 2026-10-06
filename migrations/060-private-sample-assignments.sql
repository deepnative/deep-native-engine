BEGIN;
-- Historical identifiers deliberately have no source, staff or grant foreign
-- keys. Only erasure of the owning workspace removes an actual operation.
CREATE TABLE IF NOT EXISTS private_sample_assignment_operations (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 administrator_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 reviewer_id uuid NOT NULL,
 evidence_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision BETWEEN 1 AND 20),
 submission_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 exact_grant_id uuid NOT NULL UNIQUE,
 starts_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(administrator_id,operation_id),
 CHECK(isfinite(starts_at) AND isfinite(expires_at) AND expires_at>starts_at)
);
CREATE INDEX IF NOT EXISTS private_sample_assignment_operations_source_idx
 ON private_sample_assignment_operations(evidence_id,source_revision,created_at,exact_grant_id);
CREATE INDEX IF NOT EXISTS private_sample_assignment_operations_workspace_idx
 ON private_sample_assignment_operations(workspace_id);
DROP TRIGGER IF EXISTS private_sample_assignment_operations_immutable ON private_sample_assignment_operations;
CREATE TRIGGER private_sample_assignment_operations_immutable
 BEFORE UPDATE OR DELETE ON private_sample_assignment_operations
 FOR EACH ROW EXECUTE FUNCTION reject_authorization_audit_mutation();
INSERT INTO schema_migrations(version) VALUES(60) ON CONFLICT DO NOTHING;
COMMIT;
