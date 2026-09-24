BEGIN;
CREATE TABLE IF NOT EXISTS preview_circle_memberships (
 circle_id text NOT NULL CHECK(circle_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 joined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 left_at timestamptz,
 PRIMARY KEY(circle_id,member_id),
 CHECK(left_at IS NULL OR left_at >= joined_at)
);
CREATE INDEX IF NOT EXISTS preview_circle_active_idx
 ON preview_circle_memberships(circle_id) WHERE left_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;
COMMIT;
