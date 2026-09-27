BEGIN;
ALTER TABLE assignment_attempts
 ADD COLUMN IF NOT EXISTS submission_count integer NOT NULL DEFAULT 0
 CHECK(submission_count BETWEEN 0 AND 10);

CREATE TABLE IF NOT EXISTS assignment_submission_snapshots (
 attempt_id uuid NOT NULL REFERENCES assignment_attempts(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 10),
 response text NOT NULL CHECK(length(response)<=4000 AND length(btrim(response))>=20),
 submitted_at timestamptz NOT NULL,
 PRIMARY KEY(attempt_id,sequence)
);

UPDATE assignment_attempts SET submission_count=1
 WHERE submitted_at IS NOT NULL AND submission_count=0;
INSERT INTO assignment_submission_snapshots(attempt_id,sequence,response,submitted_at)
 SELECT id,1,response,submitted_at FROM assignment_attempts
 WHERE submitted_at IS NOT NULL AND submission_count=1
 ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES(29) ON CONFLICT DO NOTHING;
COMMIT;
