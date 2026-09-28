BEGIN;
-- Local deterministic simulation only; this never enables a live provider.
-- Seed only at first creation. A missing row in an existing table remains
-- unavailable across restarts until an explicitly reviewed database repair.
DO $$ BEGIN
 IF to_regclass('local_ai_control') IS NULL
    AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=40) THEN
  CREATE TABLE local_ai_control (
   singleton boolean PRIMARY KEY CHECK(singleton),
   paused boolean NOT NULL
  );
  -- Preserve the previously accepted local simulation on first installation.
  INSERT INTO local_ai_control(singleton,paused) VALUES(true,false);
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(40) ON CONFLICT DO NOTHING;
COMMIT;
