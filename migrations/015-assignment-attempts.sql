BEGIN;
CREATE TABLE IF NOT EXISTS assignment_attempts (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 goal_at_start text NOT NULL CHECK(goal_at_start IN ('everyday','work','build')),
 response text NOT NULL DEFAULT '' CHECK(length(response)<=4000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 saved_at timestamptz,
 submitted_at timestamptz,
 UNIQUE(member_id,content_id,content_version),
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version),
 CHECK(submitted_at IS NULL OR (saved_at IS NOT NULL AND length(btrim(response))>=20))
);
CREATE INDEX IF NOT EXISTS assignment_attempts_member_idx ON assignment_attempts(member_id,started_at DESC);
INSERT INTO schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
COMMIT;
