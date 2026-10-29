BEGIN;
ALTER TABLE evidence_objects ADD COLUMN IF NOT EXISTS assignment_bound boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS assignment_evidence_origins (
 evidence_id uuid PRIMARY KEY REFERENCES evidence_objects(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,
 member_id uuid NOT NULL,
 storage_key uuid NOT NULL UNIQUE,
 attempt_id uuid NOT NULL,
 sequence integer NOT NULL,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 rubric_version integer NOT NULL CHECK(rubric_version>0),
 submitted_at timestamptz NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attempt_id,sequence) REFERENCES assignment_submission_snapshots(attempt_id,sequence) ON DELETE CASCADE,
 FOREIGN KEY(evidence_id,workspace_id) REFERENCES evidence_objects(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assignment_evidence_source_idx ON assignment_evidence_origins(attempt_id,sequence);
CREATE TABLE IF NOT EXISTS assignment_evidence_operations (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE,
 workspace_id uuid NOT NULL,
 member_id uuid NOT NULL,
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 evidence_id uuid UNIQUE REFERENCES evidence_objects(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION guard_assignment_evidence_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Assignment origin is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM evidence_objects e
   JOIN assignment_attempts a ON a.id=NEW.attempt_id AND a.member_id=NEW.member_id
   JOIN assignment_submission_snapshots s ON s.attempt_id=a.id AND s.sequence=NEW.sequence
   JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
   WHERE e.id=NEW.evidence_id AND e.workspace_id=NEW.workspace_id AND e.owner_principal_id=NEW.member_id
    AND e.storage_key=NEW.storage_key AND e.assignment_bound AND e.sha256=NEW.source_sha256
    AND e.byte_size=octet_length(convert_to(s.response,'UTF8'))
    AND e.original_name='Assignment submission '||NEW.sequence||'.txt'
    AND e.sha256=encode(sha256(convert_to(s.response,'UTF8')),'hex')
    AND a.content_id=NEW.content_id AND a.content_version=NEW.content_version
    AND cv.kind='assignment' AND cv.rubric_version=NEW.rubric_version AND cv.rubric IS NOT NULL
    AND s.submitted_at=NEW.submitted_at AND e.media_type='text/plain' AND e.quarantine_state='clean'
    AND e.revision_number=1 AND e.revision_parent_id IS NULL
    AND e.private_review_allowed AND NOT e.community_publication_allowed AND e.learning_circle_id IS NULL)
 THEN RAISE EXCEPTION 'Assignment origin requires an exact owned submitted source'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignment_evidence_origin_guard ON assignment_evidence_origins;
CREATE TRIGGER assignment_evidence_origin_guard BEFORE INSERT OR UPDATE ON assignment_evidence_origins
 FOR EACH ROW EXECUTE FUNCTION guard_assignment_evidence_origin();
CREATE OR REPLACE FUNCTION guard_assignment_evidence_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM assignment_evidence_origins o WHERE o.evidence_id=NEW.evidence_id
   AND o.workspace_id=NEW.workspace_id AND o.member_id=NEW.member_id)
  THEN RAISE EXCEPTION 'Assignment operation requires an owned bound source'; END IF;
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
  OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
  OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR (NEW.evidence_id IS DISTINCT FROM OLD.evidence_id AND
    (NEW.evidence_id IS NOT NULL OR EXISTS(SELECT 1 FROM evidence_objects WHERE id=OLD.evidence_id)))
 THEN RAISE EXCEPTION 'Assignment operation is immutable except source erasure'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignment_evidence_operation_guard ON assignment_evidence_operations;
CREATE TRIGGER assignment_evidence_operation_guard BEFORE INSERT OR UPDATE ON assignment_evidence_operations
 FOR EACH ROW EXECUTE FUNCTION guard_assignment_evidence_operation();
CREATE OR REPLACE FUNCTION guard_assignment_evidence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision_parent_id IS NOT NULL AND EXISTS(SELECT 1 FROM evidence_objects WHERE id=NEW.revision_parent_id AND assignment_bound)
 THEN RAISE EXCEPTION 'Assignment evidence cannot have independent revisions'; END IF;
 IF TG_OP='UPDATE' AND (OLD.assignment_bound OR NEW.assignment_bound) AND (
   NEW.assignment_bound IS DISTINCT FROM OLD.assignment_bound OR NEW.id IS DISTINCT FROM OLD.id
   OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id
   OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256
   OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.media_type IS DISTINCT FROM OLD.media_type
   OR NEW.original_name IS DISTINCT FROM OLD.original_name OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
   OR NEW.revision_parent_id IS DISTINCT FROM OLD.revision_parent_id OR NEW.rights_attested_at IS DISTINCT FROM OLD.rights_attested_at
   OR NEW.community_publication_allowed OR NEW.learning_circle_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Assignment evidence identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignment_evidence_identity_guard ON evidence_objects;
CREATE TRIGGER assignment_evidence_identity_guard BEFORE INSERT OR UPDATE ON evidence_objects
 FOR EACH ROW EXECUTE FUNCTION guard_assignment_evidence_identity();
CREATE OR REPLACE FUNCTION require_assignment_evidence_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid;
BEGIN
 IF TG_TABLE_NAME='evidence_objects' THEN source_id=NEW.id; ELSE source_id=OLD.evidence_id; END IF;
 IF EXISTS(SELECT 1 FROM evidence_objects e WHERE e.id=source_id AND e.assignment_bound
   AND NOT EXISTS(SELECT 1 FROM assignment_evidence_origins o WHERE o.evidence_id=e.id))
 THEN RAISE EXCEPTION 'Assignment evidence requires a retained origin'; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS assignment_evidence_requires_origin ON evidence_objects;
CREATE CONSTRAINT TRIGGER assignment_evidence_requires_origin AFTER INSERT OR UPDATE ON evidence_objects
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_assignment_evidence_origin();
DROP TRIGGER IF EXISTS assignment_origin_removal_guard ON assignment_evidence_origins;
CREATE CONSTRAINT TRIGGER assignment_origin_removal_guard AFTER DELETE ON assignment_evidence_origins
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_assignment_evidence_origin();
CREATE OR REPLACE FUNCTION guard_assignment_evidence_derivative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM evidence_objects WHERE id=NEW.evidence_id AND assignment_bound)
 THEN RAISE EXCEPTION 'Assignment evidence has no independent physical derivative'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignment_evidence_derivative_guard ON evidence_derivatives;
CREATE TRIGGER assignment_evidence_derivative_guard BEFORE INSERT OR UPDATE ON evidence_derivatives
 FOR EACH ROW EXECUTE FUNCTION guard_assignment_evidence_derivative();
CREATE OR REPLACE FUNCTION guard_bound_assignment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM assignment_evidence_origins WHERE attempt_id=OLD.id) AND (
  NEW.id IS DISTINCT FROM OLD.id OR NEW.member_id IS DISTINCT FROM OLD.member_id
  OR NEW.content_id IS DISTINCT FROM OLD.content_id OR NEW.content_version IS DISTINCT FROM OLD.content_version)
 THEN RAISE EXCEPTION 'Bound assignment identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bound_assignment_attempt_guard ON assignment_attempts;
CREATE TRIGGER bound_assignment_attempt_guard BEFORE UPDATE ON assignment_attempts
 FOR EACH ROW EXECUTE FUNCTION guard_bound_assignment_attempt();
CREATE OR REPLACE FUNCTION guard_bound_assignment_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF EXISTS(SELECT 1 FROM assignment_evidence_origins WHERE attempt_id=OLD.attempt_id AND sequence=OLD.sequence)
   AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Bound submitted source is immutable'; END IF;
  RETURN NEW;
 END IF;
 -- This trigger also runs for attempt/account cascades. Marking first invokes
 -- the existing review-time source-unavailability/withdrawal boundary. No
 -- physical derivative exists, so every linked payload is deleted atomically.
 UPDATE evidence_objects e SET quarantine_state='deleting'
  WHERE e.id IN(SELECT evidence_id FROM assignment_evidence_origins WHERE attempt_id=OLD.attempt_id AND sequence=OLD.sequence);
 DELETE FROM evidence_objects e WHERE e.id IN(
  SELECT evidence_id FROM assignment_evidence_origins WHERE attempt_id=OLD.attempt_id AND sequence=OLD.sequence);
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS bound_assignment_snapshot_guard ON assignment_submission_snapshots;
CREATE TRIGGER bound_assignment_snapshot_guard BEFORE UPDATE OR DELETE ON assignment_submission_snapshots
 FOR EACH ROW EXECUTE FUNCTION guard_bound_assignment_snapshot();
INSERT INTO schema_migrations(version) VALUES(74) ON CONFLICT DO NOTHING;
COMMIT;
