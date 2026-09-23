BEGIN;
CREATE TABLE IF NOT EXISTS career_preferences (
 member_id uuid PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,
 opted_in_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS career_entries (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES career_preferences(member_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('career','opportunity','contract')),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
 note text NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
 next_action text NOT NULL CHECK(length(next_action) BETWEEN 3 AND 500),
 self_reported_outcome text NOT NULL DEFAULT '' CHECK(length(self_reported_outcome) <= 500),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS career_entries_member_idx ON career_entries(member_id,created_at DESC,id);
CREATE TABLE IF NOT EXISTS career_drafts (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES career_preferences(member_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('professional','proposal','renewal')),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
 body text NOT NULL CHECK(length(body) BETWEEN 20 AND 4000),
 approved boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS career_drafts_member_idx ON career_drafts(member_id,created_at DESC,id);
INSERT INTO schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
COMMIT;
