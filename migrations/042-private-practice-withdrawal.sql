BEGIN;
-- Preserve the immutable member/source/version slot without retaining its text.
ALTER TABLE private_practice ALTER COLUMN response DROP NOT NULL;
ALTER TABLE private_practice ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
DO $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint WHERE conrelid='private_practice'::regclass
     AND conname='private_practice_withdrawal_check'
 ) THEN
   ALTER TABLE private_practice ADD CONSTRAINT private_practice_withdrawal_check
    CHECK ((withdrawn_at IS NULL AND response IS NOT NULL)
      OR (withdrawn_at IS NOT NULL AND response IS NULL));
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(42) ON CONFLICT DO NOTHING;
COMMIT;
