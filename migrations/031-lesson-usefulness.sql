BEGIN;
CREATE TABLE IF NOT EXISTS lesson_usefulness (
 member_id uuid NOT NULL,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 choice text NOT NULL CHECK(choice IN ('helpful','not_yet')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 reported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(member_id,content_id,content_version),
 FOREIGN KEY(member_id,content_id,content_version)
   REFERENCES lesson_activity(member_id,content_id,content_version) ON DELETE CASCADE
);
INSERT INTO schema_migrations(version) VALUES(31) ON CONFLICT DO NOTHING;
COMMIT;
