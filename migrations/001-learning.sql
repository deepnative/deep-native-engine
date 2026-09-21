BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS learners (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL UNIQUE,
 background text NOT NULL CHECK(background IN ('explorer','professional','technical')),
 goal text NOT NULL CHECK(goal IN ('everyday','work','build')),
 expires_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '30 days'
);
CREATE TABLE IF NOT EXISTS exercises (
 learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 lesson_id text NOT NULL,
 lesson_version integer NOT NULL CHECK(lesson_version > 0),
 instruction text NOT NULL CHECK(length(instruction) <= 2000),
 verification text NOT NULL CHECK(length(verification) <= 1000),
 completed_at timestamptz,
 PRIMARY KEY(learner_id,lesson_id,lesson_version)
);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
