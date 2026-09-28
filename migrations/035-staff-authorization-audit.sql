BEGIN;
-- Preserve actual historical support reads, including their IDs and times.
-- Do not manufacture grant/revoke events for operations predating this migration.
DO $$ BEGIN
 IF EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema=current_schema() AND table_name='authorization_audit'
    AND column_name='support_access_id'
 ) THEN
  ALTER TABLE authorization_audit
   DROP CONSTRAINT authorization_audit_support_access_id_fkey,
   DROP CONSTRAINT authorization_audit_staff_id_fkey,
   DROP CONSTRAINT authorization_audit_action_check;
  ALTER TABLE authorization_audit RENAME COLUMN support_access_id TO grant_id;
  ALTER TABLE authorization_audit ADD COLUMN actor_id uuid;
  ALTER TABLE authorization_audit ADD COLUMN grant_type text;
  UPDATE authorization_audit SET actor_id=staff_id,grant_type='support';
  ALTER TABLE authorization_audit
   ALTER COLUMN actor_id SET NOT NULL,
   ALTER COLUMN grant_type SET NOT NULL,
   DROP COLUMN purpose;
  ALTER TABLE authorization_audit
   ADD CONSTRAINT authorization_audit_grant_type_check
    CHECK(grant_type IN ('assignment','support','evidence_review')),
   ADD CONSTRAINT authorization_audit_action_check
    CHECK(action IN ('grant_created','grant_revoked','workspace_read','support_content_read')),
   ADD CONSTRAINT authorization_audit_read_action_check
    CHECK((action<>'support_content_read' OR grant_type='support')
      AND (action NOT IN ('workspace_read','support_content_read') OR actor_id=staff_id)
      AND (action<>'workspace_read' OR grant_type IN ('assignment','support')));
 END IF;
END $$;
-- UUID references to actor/staff/grant are historical identifiers, not cascading
-- links. Only local workspace deletion removes its history.
CREATE INDEX IF NOT EXISTS authorization_audit_workspace_idx
 ON authorization_audit(workspace_id,id);
CREATE OR REPLACE FUNCTION reject_authorization_audit_mutation()
RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
  RAISE EXCEPTION 'Staff authorization event history is immutable';
 END IF;
 RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS authorization_audit_immutable ON authorization_audit;
CREATE TRIGGER authorization_audit_immutable
 BEFORE UPDATE OR DELETE ON authorization_audit
 FOR EACH ROW EXECUTE FUNCTION reject_authorization_audit_mutation();
INSERT INTO schema_migrations(version) VALUES(35) ON CONFLICT DO NOTHING;
COMMIT;
