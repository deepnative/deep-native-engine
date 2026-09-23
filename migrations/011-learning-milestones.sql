BEGIN;
CREATE TABLE IF NOT EXISTS learning_milestones (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 goal_title text NOT NULL CHECK(length(goal_title) BETWEEN 3 AND 160),
 milestone_title text NOT NULL CHECK(length(milestone_title) BETWEEN 3 AND 160),
 evidence_note text NOT NULL DEFAULT '' CHECK(length(evidence_note) <= 1000),
 next_action text NOT NULL CHECK(length(next_action) BETWEEN 3 AND 500),
 reminder_date date,
 reminder_time time without time zone,
 reminder_time_zone text CHECK(reminder_time_zone IS NULL OR length(reminder_time_zone) <= 64),
 self_reported_complete boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((reminder_date IS NULL AND reminder_time IS NULL AND reminder_time_zone IS NULL)
    OR (reminder_date IS NOT NULL AND reminder_time IS NOT NULL AND reminder_time_zone IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS learning_milestones_member_created_idx
 ON learning_milestones(member_id,created_at DESC,id);
INSERT INTO schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
COMMIT;
