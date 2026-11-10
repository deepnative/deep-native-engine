BEGIN;
-- #121: a member deliberately withdraws from their local program term. This
-- is a dated learning event, distinct from deleting the account: the
-- enrollment receipt and earlier activity stay, and the seat is not reopened.
-- One withdrawal per enrollment; it is immutable and leaves with the account.
CREATE TABLE IF NOT EXISTS local_program_withdrawals (
 enrollment_id uuid PRIMARY KEY REFERENCES local_program_enrollments(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(withdrawn_at))
);
CREATE OR REPLACE FUNCTION guard_local_program_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Program withdrawal is immutable'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  THEN RAISE EXCEPTION 'Program withdrawal is retained until account erasure'; END IF;
  RETURN OLD;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM local_program_enrollments
   WHERE id=NEW.enrollment_id AND workspace_id=NEW.workspace_id AND enrolled_at<=clock_timestamp())
 THEN RAISE EXCEPTION 'Program withdrawal requires its own enrollment'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_program_withdrawal_guard ON local_program_withdrawals;
CREATE TRIGGER local_program_withdrawal_guard BEFORE INSERT OR UPDATE OR DELETE
 ON local_program_withdrawals FOR EACH ROW EXECUTE FUNCTION guard_local_program_withdrawal();
INSERT INTO schema_migrations(version) VALUES(135) ON CONFLICT DO NOTHING;
COMMIT;
