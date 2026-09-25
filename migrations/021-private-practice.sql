BEGIN;
CREATE TABLE IF NOT EXISTS private_practice (
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 goal_at_save text NOT NULL CHECK(goal_at_save IN ('everyday','work','build')),
 response text NOT NULL CHECK(length(btrim(response)) BETWEEN 1 AND 1000),
 saved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(member_id,content_id,content_version),
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version)
);
CREATE INDEX IF NOT EXISTS private_practice_member_idx ON private_practice(member_id,saved_at DESC);
INSERT INTO schema_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
COMMIT;
