BEGIN;
CREATE TABLE IF NOT EXISTS billing_profiles (
 owner_id uuid PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
 revision integer NOT NULL CHECK(revision>0)
);
INSERT INTO schema_migrations(version) VALUES(85) ON CONFLICT DO NOTHING;
COMMIT;
