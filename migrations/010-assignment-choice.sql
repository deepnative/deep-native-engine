BEGIN;
ALTER TABLE content_versions ADD COLUMN IF NOT EXISTS minimum_experience text NOT NULL DEFAULT 'new'
  CHECK(minimum_experience IN ('new','some','experienced'));
CREATE TABLE IF NOT EXISTS learner_assignment_choices (
 member_id uuid PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 chosen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version)
);
INSERT INTO schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
COMMIT;
