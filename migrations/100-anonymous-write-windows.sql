BEGIN;
-- #728 Fixed-window counts for signup and password sign-in. A subject is a hash
-- keyed with a value that never reaches the database, or the literal 'service'
-- for the whole-service count. Rows are removed within a day.
CREATE TABLE IF NOT EXISTS anonymous_write_windows (
 kind text NOT NULL CHECK(kind IN ('signup','password_sign_in')),
 subject text NOT NULL CHECK(subject='service' OR subject ~ '^[a-f0-9]{64}$'),
 window_start timestamptz NOT NULL,
 admitted integer NOT NULL CHECK(admitted>0),
 PRIMARY KEY(kind,subject,window_start)
);
CREATE INDEX IF NOT EXISTS anonymous_write_windows_retention_idx
 ON anonymous_write_windows(window_start);
INSERT INTO schema_migrations(version) VALUES(100) ON CONFLICT DO NOTHING;
COMMIT;
