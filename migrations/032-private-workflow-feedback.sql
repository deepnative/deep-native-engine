BEGIN;
CREATE TABLE IF NOT EXISTS workflow_feedback (
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workflow_id text NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 32),
 workflow_version integer NOT NULL CHECK(workflow_version > 0),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 1000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(member_id,workflow_id,workflow_version)
);
INSERT INTO schema_migrations(version) VALUES(32) ON CONFLICT DO NOTHING;
COMMIT;
