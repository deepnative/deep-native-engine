BEGIN;
-- #125 with the owner's 10 Nov 2026 decision: a private feedback copy of a
-- submitted assignment is kept until the member deletes it, the original
-- attempt or their account, and there is no appeal path. The member agrees to
-- one versioned wording that says so; this column records which wording.
-- Copies made before this migration stay NULL. They are never back-filled:
-- the origin row is immutable (migration 074) and nobody agreed to a version.
ALTER TABLE assignment_evidence_origins ADD COLUMN IF NOT EXISTS consent_version text
 CHECK(consent_version IS NULL OR consent_version ~ '^assignment-feedback-v[1-9][0-9]{0,3}$');
INSERT INTO schema_migrations(version) VALUES(137) ON CONFLICT DO NOTHING;
COMMIT;
