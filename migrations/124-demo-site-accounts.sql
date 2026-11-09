BEGIN;
-- #123 DEMOACCT: each member account records whether it was created while the
-- site ran as a demo, so metrics never mix demo accounts with live ones.
-- Accounts that already exist are demo accounts: the hosted site has only ever
-- run as a demo, and nothing has launched. The answer is fixed at creation.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=124) THEN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
   AND table_name='learners' AND column_name='created_on_demo_site') THEN
  ALTER TABLE learners ADD COLUMN created_on_demo_site boolean;
  UPDATE learners SET created_on_demo_site=true;
 END IF;
 ALTER TABLE learners ALTER COLUMN created_on_demo_site SET DEFAULT false;
 ALTER TABLE learners ALTER COLUMN created_on_demo_site SET NOT NULL;
END IF;
END $$;
CREATE OR REPLACE FUNCTION keep_learner_demo_site() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.created_on_demo_site IS DISTINCT FROM OLD.created_on_demo_site THEN
  RAISE EXCEPTION 'An account''s demo origin cannot change';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS learners_demo_site_fixed ON learners;
CREATE TRIGGER learners_demo_site_fixed BEFORE UPDATE OF created_on_demo_site ON learners
 FOR EACH ROW EXECUTE FUNCTION keep_learner_demo_site();
INSERT INTO schema_migrations(version) VALUES(124) ON CONFLICT DO NOTHING;
COMMIT;
