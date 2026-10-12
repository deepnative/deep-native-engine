BEGIN;
-- Only new platform-owned fixed examples have an origin record. Legacy uploads
-- keep their actual pending/clean state; no origin or timestamp is inferred.
CREATE TABLE IF NOT EXISTS provided_evidence_origins (
 evidence_id uuid PRIMARY KEY REFERENCES evidence_objects(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,
 member_id uuid NOT NULL,
 storage_key uuid NOT NULL UNIQUE,
 template_id text NOT NULL CHECK(template_id IN ('everyday-options','work-next-steps','technical-checks')),
 template_version integer NOT NULL CHECK(template_version=1),
 template_digest text NOT NULL CHECK(template_digest ~ '^[a-f0-9]{64}$'),
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(evidence_id,workspace_id) REFERENCES evidence_objects(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS provided_evidence_operations (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE,
 workspace_id uuid NOT NULL,
 member_id uuid NOT NULL,
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 evidence_id uuid UNIQUE REFERENCES evidence_objects(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION guard_provided_evidence_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Provided origin is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM evidence_objects e WHERE e.id=NEW.evidence_id
    AND e.workspace_id=NEW.workspace_id AND e.owner_principal_id=NEW.member_id
    AND e.storage_key=NEW.storage_key AND e.sha256=NEW.template_digest
    AND e.media_type='text/plain' AND e.quarantine_state='clean'
    AND e.revision_number=1 AND e.revision_parent_id IS NULL
    AND e.private_review_allowed AND NOT e.community_publication_allowed
    AND e.learning_circle_id IS NULL) THEN
  RAISE EXCEPTION 'Provided origin must bind an exact private source';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS provided_evidence_origin_guard ON provided_evidence_origins;
CREATE TRIGGER provided_evidence_origin_guard BEFORE INSERT OR UPDATE ON provided_evidence_origins
 FOR EACH ROW EXECUTE FUNCTION guard_provided_evidence_origin();
CREATE OR REPLACE FUNCTION guard_provided_evidence_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM provided_evidence_origins o WHERE o.evidence_id=NEW.evidence_id
    AND o.workspace_id=NEW.workspace_id AND o.member_id=NEW.member_id) THEN
   RAISE EXCEPTION 'Provided operation requires an owned provided source';
  END IF;
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
   OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
   OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at
   OR (NEW.evidence_id IS DISTINCT FROM OLD.evidence_id AND
     (NEW.evidence_id IS NOT NULL OR EXISTS(SELECT 1 FROM evidence_objects WHERE id=OLD.evidence_id))) THEN
  RAISE EXCEPTION 'Provided operation is immutable except source erasure';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS provided_evidence_operation_guard ON provided_evidence_operations;
CREATE TRIGGER provided_evidence_operation_guard BEFORE INSERT OR UPDATE ON provided_evidence_operations
 FOR EACH ROW EXECUTE FUNCTION guard_provided_evidence_operation();
-- Consent/quarantine/deletion may still change normally; the exact prepared
-- identity and its no-public-sharing boundary cannot change in-place.
CREATE OR REPLACE FUNCTION guard_provided_source_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM provided_evidence_origins WHERE evidence_id=OLD.id) AND (
   NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
   OR NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id
   OR NEW.original_name IS DISTINCT FROM OLD.original_name OR NEW.media_type IS DISTINCT FROM OLD.media_type
   OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.sha256 IS DISTINCT FROM OLD.sha256
   OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
   OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
   OR NEW.revision_parent_id IS DISTINCT FROM OLD.revision_parent_id
   OR NEW.rights_attested_at IS DISTINCT FROM OLD.rights_attested_at
   OR NEW.community_publication_allowed OR NEW.learning_circle_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Provided source identity is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS provided_source_identity_guard ON evidence_objects;
CREATE TRIGGER provided_source_identity_guard BEFORE UPDATE ON evidence_objects
 FOR EACH ROW EXECUTE FUNCTION guard_provided_source_identity();
INSERT INTO schema_migrations(version) VALUES(70) ON CONFLICT DO NOTHING;
COMMIT;
