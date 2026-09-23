BEGIN;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS background_tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS domain_tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS it_roles text[] NOT NULL DEFAULT '{}';
ALTER TABLE learners ADD COLUMN IF NOT EXISTS experience text CHECK (experience IN ('new','some','experienced'));
ALTER TABLE learners ADD COLUMN IF NOT EXISTS exploratory boolean NOT NULL DEFAULT false;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS goal_at_start text CHECK (goal_at_start IN ('everyday','work','build'));
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
COMMIT;
