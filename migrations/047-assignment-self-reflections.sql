BEGIN;
CREATE TABLE IF NOT EXISTS assignment_submission_reflections (
 attempt_id uuid NOT NULL,
 sequence integer NOT NULL,
 evidence text NOT NULL CHECK(length(evidence)<=1000),
 gaps text NOT NULL CHECK(length(gaps)<=1000),
 intention text NOT NULL CHECK(length(intention)<=1000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(attempt_id,sequence),
 FOREIGN KEY(attempt_id,sequence)
   REFERENCES assignment_submission_snapshots(attempt_id,sequence) ON DELETE CASCADE,
 CHECK(deleted_at IS NULL OR (evidence='' AND gaps='' AND intention=''))
);

-- A member can delete the text while keeping an irreversible CAS tombstone.
-- Attempt/account deletion still cascades the tombstone itself.
CREATE OR REPLACE FUNCTION preserve_deleted_assignment_reflection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'Deleted assignment reflection cannot be restored';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignment_reflection_tombstone ON assignment_submission_reflections;
CREATE TRIGGER assignment_reflection_tombstone
 BEFORE UPDATE ON assignment_submission_reflections FOR EACH ROW
 EXECUTE FUNCTION preserve_deleted_assignment_reflection();

INSERT INTO schema_migrations(version) VALUES(47) ON CONFLICT DO NOTHING;
COMMIT;
