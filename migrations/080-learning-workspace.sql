BEGIN;
CREATE TABLE IF NOT EXISTS learning_workspace_notebooks (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 variant text NOT NULL CHECK(variant IN ('everyday','work','technical')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 decision_sequence integer NOT NULL DEFAULT 0 CHECK(decision_sequence>=0),
 draft_revision integer NOT NULL DEFAULT 1 CHECK(draft_revision>0),
 draft_based_on_sequence integer NOT NULL DEFAULT 0 CHECK(draft_based_on_sequence>=0),
 metadata jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version),
 CHECK((deleted_at IS NULL)=(metadata IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_workspace_active_identity
 ON learning_workspace_notebooks(member_id,content_id,content_version,content_hash,variant) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS learning_workspace_fields (
 notebook_id uuid NOT NULL REFERENCES learning_workspace_notebooks(id) ON DELETE CASCADE,
 field_key text NOT NULL CHECK(length(field_key) BETWEEN 1 AND 80),
 value_json text NOT NULL CHECK(octet_length(value_json) BETWEEN 2 AND 180002),
 PRIMARY KEY(notebook_id,field_key)
);
COMMENT ON COLUMN learning_workspace_fields.value_json IS 'json-string-v1: canonical JSON string stored as TEXT; decode only in JavaScript to preserve NUL and isolated UTF-16 surrogates';
CREATE TABLE IF NOT EXISTS learning_workspace_decisions (
 notebook_id uuid NOT NULL REFERENCES learning_workspace_notebooks(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence>0),
 metadata jsonb NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(notebook_id,sequence)
);
CREATE TABLE IF NOT EXISTS learning_workspace_decision_fields (
 notebook_id uuid NOT NULL,
 sequence integer NOT NULL,
 field_key text NOT NULL CHECK(field_key IN ('text','reason','question','proposedText')),
 value_json text NOT NULL CHECK(octet_length(value_json) BETWEEN 2 AND 180002),
 PRIMARY KEY(notebook_id,sequence,field_key),
 FOREIGN KEY(notebook_id,sequence) REFERENCES learning_workspace_decisions(notebook_id,sequence) ON DELETE CASCADE
);
COMMENT ON COLUMN learning_workspace_decision_fields.value_json IS 'json-string-v1; decode only in JavaScript';
CREATE TABLE IF NOT EXISTS learning_workspace_operations (
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 notebook_id uuid NOT NULL REFERENCES learning_workspace_notebooks(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('create','save','append','remove')),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL CHECK(revision>0),
 decision_sequence integer NOT NULL CHECK(decision_sequence>=0),
 saved_at timestamptz NOT NULL,
 PRIMARY KEY(member_id,operation_id)
);
CREATE OR REPLACE FUNCTION preserve_learning_workspace_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Learning feedback decisions are immutable'; END $$;
DROP TRIGGER IF EXISTS learning_workspace_decisions_immutable ON learning_workspace_decisions;
CREATE TRIGGER learning_workspace_decisions_immutable BEFORE UPDATE ON learning_workspace_decisions FOR EACH ROW EXECUTE FUNCTION preserve_learning_workspace_decision();
DROP TRIGGER IF EXISTS learning_workspace_decision_fields_immutable ON learning_workspace_decision_fields;
CREATE TRIGGER learning_workspace_decision_fields_immutable BEFORE UPDATE ON learning_workspace_decision_fields FOR EACH ROW EXECUTE FUNCTION preserve_learning_workspace_decision();
INSERT INTO schema_migrations(version) VALUES(80) ON CONFLICT DO NOTHING;
COMMIT;
