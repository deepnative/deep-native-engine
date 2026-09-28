BEGIN;
-- Proposal reads are not grant-authorized: preserve their own content-free history.
-- Actor/member/proposal UUIDs are historical identifiers, not cascading links.
-- Only deletion of the actual owning workspace removes its local events.
CREATE TABLE IF NOT EXISTS proposal_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 actor_role text NOT NULL CHECK(actor_role IN ('moderator','platform_admin')),
 workspace_id uuid NOT NULL,
 member_id uuid NOT NULL,
 proposal_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('proposal_read','proposal_quarantined','proposal_rejected')),
 old_state text NOT NULL CHECK(old_state IN ('submitted','quarantined')),
 new_state text NOT NULL CHECK(new_state IN ('submitted','quarantined','rejected')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 CHECK((action='proposal_read' AND old_state=new_state)
    OR (action='proposal_quarantined' AND old_state='submitted' AND new_state='quarantined')
    OR (action='proposal_rejected' AND new_state='rejected'))
);
CREATE INDEX IF NOT EXISTS proposal_audit_workspace_idx ON proposal_audit(workspace_id,id);
CREATE OR REPLACE FUNCTION reject_proposal_audit_mutation() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
  RAISE EXCEPTION 'Proposal event history is immutable';
 END IF;
 RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS proposal_audit_immutable ON proposal_audit;
CREATE TRIGGER proposal_audit_immutable BEFORE UPDATE OR DELETE ON proposal_audit
 FOR EACH ROW EXECUTE FUNCTION reject_proposal_audit_mutation();
-- No inferred historical reads or moderation events are inserted.
INSERT INTO schema_migrations(version) VALUES(38) ON CONFLICT DO NOTHING;
COMMIT;
