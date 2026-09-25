BEGIN;
CREATE TABLE IF NOT EXISTS reviewer_evidence_grants (
 id uuid PRIMARY KEY,
 reviewer_id uuid NOT NULL,
 reviewer_role text NOT NULL DEFAULT 'reviewer' CHECK(reviewer_role='reviewer'),
 assignment_id uuid NOT NULL REFERENCES assignment_grants(id) ON DELETE CASCADE,
 submission_id uuid NOT NULL REFERENCES evidence_review_submissions(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 200),
 starts_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 granted_by uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(expires_at>starts_at),
 FOREIGN KEY(reviewer_id,reviewer_role)
   REFERENCES staff_profiles(principal_id,role) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS reviewer_evidence_grants_active_idx
 ON reviewer_evidence_grants(reviewer_id,assignment_id,submission_id,expires_at)
 WHERE revoked_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(22) ON CONFLICT DO NOTHING;
COMMIT;
