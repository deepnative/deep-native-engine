BEGIN;
CREATE TABLE IF NOT EXISTS principals (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('member','staff')),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,kind)
);
INSERT INTO principals(id,token_hash,kind,expires_at)
 SELECT id,token_hash,'member',expires_at FROM learners
 ON CONFLICT DO NOTHING;
DO $$ BEGIN
 ALTER TABLE learners ADD CONSTRAINT learners_principal_fk
  FOREIGN KEY(id) REFERENCES principals(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS workspaces (
 id uuid PRIMARY KEY,
 owner_principal_id uuid NOT NULL UNIQUE,
 owner_kind text NOT NULL DEFAULT 'member' CHECK(owner_kind='member'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,owner_principal_id),
 FOREIGN KEY(owner_principal_id,owner_kind) REFERENCES principals(id,kind) ON DELETE CASCADE
);
INSERT INTO workspaces(id,owner_principal_id)
 SELECT id,id FROM learners ON CONFLICT DO NOTHING;
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS workspace_id uuid;
UPDATE exercises SET workspace_id=learner_id WHERE workspace_id IS NULL;
ALTER TABLE exercises ALTER COLUMN workspace_id SET NOT NULL;
DO $$ BEGIN
 ALTER TABLE exercises ADD CONSTRAINT exercises_owned_workspace_fk
  FOREIGN KEY(workspace_id,learner_id)
  REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS staff_profiles (
 principal_id uuid PRIMARY KEY,
 principal_kind text NOT NULL DEFAULT 'staff' CHECK(principal_kind='staff'),
 role text NOT NULL CHECK(role IN ('coach','reviewer','editor','moderator','operator','platform_admin')),
 UNIQUE(principal_id,role),
 FOREIGN KEY(principal_id,principal_kind) REFERENCES principals(id,kind) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS assignment_grants (
 id uuid PRIMARY KEY,
 staff_id uuid NOT NULL,
 staff_role text NOT NULL CHECK(staff_role IN ('coach','reviewer')),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 200),
 starts_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 granted_by uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(expires_at>starts_at),
 FOREIGN KEY(staff_id,staff_role) REFERENCES staff_profiles(principal_id,role) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assignment_grants_active_idx
 ON assignment_grants(staff_id,workspace_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS support_access_grants (
 id uuid PRIMARY KEY,
 staff_id uuid NOT NULL,
 staff_role text NOT NULL CHECK(staff_role IN ('operator','platform_admin')),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 200),
 starts_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 granted_by uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(expires_at>starts_at),
 FOREIGN KEY(staff_id,staff_role) REFERENCES staff_profiles(principal_id,role) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS support_access_active_idx
 ON support_access_grants(staff_id,workspace_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS authorization_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 staff_id uuid NOT NULL REFERENCES staff_profiles(principal_id),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 support_access_id uuid NOT NULL REFERENCES support_access_grants(id),
 action text NOT NULL CHECK(action='support_content_read'),
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 200),
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cohorts (
 id text PRIMARY KEY CHECK(id ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);
CREATE TABLE IF NOT EXISTS cohort_memberships (
 cohort_id text NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 can_read_shared_content boolean NOT NULL DEFAULT false,
 expires_at timestamptz,
 revoked_at timestamptz,
 PRIMARY KEY(cohort_id,member_id)
);
CREATE TABLE IF NOT EXISTS cohort_content (
 cohort_id text NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
 content_id text NOT NULL CHECK(content_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 PRIMARY KEY(cohort_id,content_id)
);
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
