BEGIN;
-- Keep completion/version metadata while removing both retained answer fields.
-- A rollback must preserve tombstones: old NOT NULL code cannot safely read them.
ALTER TABLE exercises ALTER COLUMN instruction DROP NOT NULL;
ALTER TABLE exercises ALTER COLUMN verification DROP NOT NULL;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
DO $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint WHERE conrelid='exercises'::regclass
     AND conname='exercise_withdrawal_check'
 ) THEN
   ALTER TABLE exercises ADD CONSTRAINT exercise_withdrawal_check
    CHECK ((withdrawn_at IS NULL AND instruction IS NOT NULL AND verification IS NOT NULL)
      OR (withdrawn_at IS NOT NULL AND instruction IS NULL AND verification IS NULL
          AND completed_at IS NOT NULL));
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(43) ON CONFLICT DO NOTHING;
COMMIT;
