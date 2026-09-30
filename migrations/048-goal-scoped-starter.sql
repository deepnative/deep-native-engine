BEGIN;
-- Preserve all legacy business values, including the absence of a recorded goal.
-- Never roll back by collapsing slots: old application code is incompatible.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS goal_slot text
 GENERATED ALWAYS AS (COALESCE(goal_at_start,'unattributed')) STORED;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=48) THEN
  ALTER TABLE exercises DROP CONSTRAINT exercises_pkey;
  ALTER TABLE exercises ADD PRIMARY KEY(learner_id,lesson_id,lesson_version,goal_slot);
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(48) ON CONFLICT DO NOTHING;
COMMIT;
