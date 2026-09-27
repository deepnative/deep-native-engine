BEGIN;
CREATE TABLE IF NOT EXISTS expert_availability_slots (
 id uuid PRIMARY KEY,
 expert_registry_id uuid NOT NULL REFERENCES expert_registry(id) ON DELETE CASCADE,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 created_by uuid NOT NULL REFERENCES staff_profiles(principal_id),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(ends_at > starts_at),
 CHECK(ends_at - starts_at = INTERVAL '60 minutes')
);
CREATE INDEX IF NOT EXISTS expert_availability_active_idx
 ON expert_availability_slots(expert_registry_id,starts_at)
 WHERE retired_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(27) ON CONFLICT DO NOTHING;
COMMIT;
