BEGIN;
-- #689 DEFCOACH-01: a learner can have several coaches.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname='coach_assignments_pkey'
               AND conrelid='coach_assignments'::regclass
               AND array_length(conkey,1)=1) THEN
  ALTER TABLE coach_assignments DROP CONSTRAINT coach_assignments_pkey;
  ALTER TABLE coach_assignments
   ADD CONSTRAINT coach_assignments_pkey PRIMARY KEY(learner_id, coach_email_hash);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS coach_assignments_learner ON coach_assignments(learner_id);
-- A NULL assigned_by marks an automatic default assignment.
ALTER TABLE coach_assignments ALTER COLUMN assigned_by DROP NOT NULL;
-- DEFCOACH-02: the default coaches, seeded once for the two owners.
CREATE TABLE IF NOT EXISTS default_coaches (
 email_hash text PRIMARY KEY CHECK(email_hash ~ '^[a-f0-9]{64}$')
);
INSERT INTO default_coaches(email_hash)
SELECT encode(sha256(convert_to(address, 'UTF8')), 'hex')
  FROM unnest(ARRAY['shi@deepnative.io','tom@deepnative.io']) AS address
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=97)
ON CONFLICT DO NOTHING;
-- DEFCOACH-03: each new learner gets every default coach who holds the role.
CREATE OR REPLACE FUNCTION assign_default_coaches() RETURNS trigger AS $$
BEGIN
 INSERT INTO coach_assignments(learner_id, coach_email_hash)
 SELECT NEW.id, d.email_hash FROM default_coaches d
   JOIN account_roles r ON r.email_hash=d.email_hash AND r.role='coach'
 ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS learners_default_coaches ON learners;
CREATE TRIGGER learners_default_coaches AFTER INSERT ON learners
 FOR EACH ROW EXECUTE FUNCTION assign_default_coaches();
-- DEFCOACH-02/05: existing learners are assigned once; a removed default
-- assignment is not restored on the next start.
INSERT INTO coach_assignments(learner_id, coach_email_hash)
SELECT l.id, d.email_hash FROM learners l
 CROSS JOIN default_coaches d
  JOIN account_roles r ON r.email_hash=d.email_hash AND r.role='coach'
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=97)
ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(97) ON CONFLICT DO NOTHING;
COMMIT;
