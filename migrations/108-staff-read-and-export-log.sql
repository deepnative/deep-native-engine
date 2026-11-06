BEGIN;
-- #40 NOTEREAD: when a moderator opened a workflow note sent for private review.
-- Actor, grant and request IDs are historical identifiers, not cascading links,
-- so an entry outlasts the access and the moderator's account. No note text.
-- Only deletion of the owning workspace removes its entries. No earlier reads
-- are inferred: nothing recorded them.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=108) THEN
CREATE TABLE workflow_review_read_audit (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 workflow_id text NOT NULL,
 workflow_version integer NOT NULL CHECK(workflow_version>0),
 revision integer NOT NULL CHECK(revision>0),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at))
);
CREATE INDEX workflow_review_read_audit_workspace
 ON workflow_review_read_audit(workspace_id,occurred_at DESC,id DESC);
CREATE TRIGGER workflow_review_read_audit_immutable BEFORE UPDATE OR DELETE ON workflow_review_read_audit
 FOR EACH ROW EXECUTE FUNCTION reject_authorization_audit_mutation();
-- #40 EXPORTLOG: staff taking a file of data that no other log covers. It says
-- who and which export, and outlasts the staff account. It holds no data.
CREATE TABLE staff_export_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('metrics_json')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at))
);
CREATE TRIGGER staff_export_events_append_only BEFORE UPDATE OR DELETE ON staff_export_events
 FOR EACH ROW EXECUTE FUNCTION preserve_staff_change_event();
INSERT INTO schema_migrations(version) VALUES(108) ON CONFLICT DO NOTHING;
END IF;
END $$;
COMMIT;
