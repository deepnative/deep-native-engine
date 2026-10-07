BEGIN;
CREATE TABLE IF NOT EXISTS workflow_review_requests (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 source_instance_id uuid NOT NULL,
 workflow_id text NOT NULL CHECK(workflow_id ~ '^WF-[0-9]{3}$'),
 workflow_version integer NOT NULL CHECK(workflow_version>0),
 source_revision integer NOT NULL CHECK(source_revision>0),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 withdrawn_at timestamptz CHECK(withdrawn_at IS NULL OR isfinite(withdrawn_at)),
 CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS workflow_review_requests_owner_idx
 ON workflow_review_requests(member_id,created_at,id);
CREATE INDEX IF NOT EXISTS workflow_review_requests_source_idx
 ON workflow_review_requests(source_instance_id,source_revision);

CREATE TABLE IF NOT EXISTS workflow_review_grants (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES workflow_review_requests(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 moderator_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 administrator_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 source_instance_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 revoked_at timestamptz CHECK(revoked_at IS NULL OR isfinite(revoked_at)),
 CHECK(expires_at>created_at),
 CHECK(expires_at>starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_review_one_current_grant
 ON workflow_review_grants(request_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_review_grant_moderator
 ON workflow_review_grants(moderator_id,created_at,id);

-- A global operation key stays reserved after erasure, with no remaining
-- actor, source, receipt, workspace, instruction or private text linkage.
CREATE TABLE IF NOT EXISTS workflow_review_operations (
 operation_id uuid PRIMARY KEY,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
 kind text CHECK(kind IN ('request','withdraw','assign','revoke')),
 instruction jsonb CHECK(instruction IS NULL OR jsonb_typeof(instruction)='object'),
 receipt_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 CHECK((actor_id IS NULL AND workspace_id IS NULL AND kind IS NULL AND instruction IS NULL AND receipt_id IS NULL)
  OR (actor_id IS NOT NULL AND workspace_id IS NOT NULL AND kind IS NOT NULL AND instruction IS NOT NULL AND receipt_id IS NOT NULL))
);
CREATE OR REPLACE FUNCTION guard_workflow_review_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Private review operation key is reserved'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
   OR NOT ((NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id))
    OR (NEW.workspace_id IS NULL AND OLD.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)))
  THEN RAISE EXCEPTION 'Private review operation is immutable'; END IF;
  NEW.actor_id=NULL; NEW.workspace_id=NULL; NEW.kind=NULL; NEW.instruction=NULL; NEW.receipt_id=NULL;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM principals p JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE p.id=NEW.actor_id AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
   AND ((NEW.kind IN ('request','withdraw') AND p.kind='member' AND w.owner_principal_id=p.id)
    OR (NEW.kind IN ('assign','revoke') AND p.kind='staff' AND EXISTS(
     SELECT 1 FROM staff_profiles s WHERE s.principal_id=p.id AND s.role='platform_admin'))))
 THEN RAISE EXCEPTION 'Private review operation authority required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_review_operation_guard ON workflow_review_operations;
CREATE TRIGGER workflow_review_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_review_operations
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_review_operation();
INSERT INTO schema_migrations(version) VALUES(65) ON CONFLICT DO NOTHING;
COMMIT;
