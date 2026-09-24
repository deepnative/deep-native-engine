BEGIN;
CREATE TABLE IF NOT EXISTS lesson_activity (
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 started_at timestamptz,
 self_assessed_at timestamptz,
 PRIMARY KEY(member_id,content_id,content_version),
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version),
 CHECK(self_assessed_at IS NULL OR started_at IS NOT NULL)
);
INSERT INTO schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;
COMMIT;
