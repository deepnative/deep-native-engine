BEGIN;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS time_zone text CHECK(time_zone IS NULL OR length(time_zone) <= 64);
ALTER TABLE learners ADD COLUMN IF NOT EXISTS weekly_minutes smallint CHECK(weekly_minutes IN (15,30,60,120));
INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
COMMIT;
