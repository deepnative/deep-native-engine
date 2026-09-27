BEGIN;
ALTER TABLE adapter_jobs
 ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES learners(id) ON DELETE CASCADE;
DO $$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conname='adapter_jobs_member_mode_check'
     AND conrelid='adapter_jobs'::regclass
 ) THEN
   ALTER TABLE adapter_jobs ADD CONSTRAINT adapter_jobs_member_mode_check
     CHECK(member_id IS NULL OR mode IN ('demo','test'));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS adapter_jobs_member_idx
 ON adapter_jobs(member_id,created_at,id) WHERE member_id IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES(30) ON CONFLICT DO NOTHING;
COMMIT;
