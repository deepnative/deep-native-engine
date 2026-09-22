BEGIN;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleting_at timestamptz;
CREATE TABLE IF NOT EXISTS evidence_objects (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 owner_principal_id uuid NOT NULL,
 owner_kind text NOT NULL DEFAULT 'member' CHECK(owner_kind='member'),
 original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 200),
 media_type text NOT NULL CHECK(media_type IN ('text/plain','image/png','application/pdf')),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 1048576),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 storage_key uuid NOT NULL UNIQUE,
 quarantine_state text NOT NULL DEFAULT 'pending'
  CHECK(quarantine_state IN ('pending','clean','rejected','infected','deleting')),
 private_review_allowed boolean NOT NULL,
 community_publication_allowed boolean NOT NULL,
 learning_circle_id text REFERENCES cohorts(id),
 rights_attested_at timestamptz NOT NULL,
 scanned_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,workspace_id),
 FOREIGN KEY(workspace_id,owner_principal_id)
  REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_principal_id,owner_kind)
  REFERENCES principals(id,kind) ON DELETE CASCADE,
 CHECK(private_review_allowed OR community_publication_allowed OR learning_circle_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS evidence_objects_workspace_idx
 ON evidence_objects(workspace_id,created_at);

CREATE TABLE IF NOT EXISTS evidence_review_submissions (
 id uuid PRIMARY KEY,
 evidence_id uuid NOT NULL UNIQUE REFERENCES evidence_objects(id) ON DELETE CASCADE,
 submitted_by uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','reviewed','withdrawn')),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS evidence_derivatives (
 id uuid PRIMARY KEY,
 evidence_id uuid NOT NULL REFERENCES evidence_objects(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('text-extract','thumbnail')),
 storage_key uuid NOT NULL UNIQUE,
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 1048576),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(evidence_id,kind)
);

INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
COMMIT;
