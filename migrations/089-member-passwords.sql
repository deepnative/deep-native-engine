BEGIN;
-- #627 email and password sign-in. Only a salted scrypt hash is stored, and
-- only for a member whose email is verified. Rows follow principal deletion.
CREATE TABLE IF NOT EXISTS member_passwords (
 principal_id uuid PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
 password_hash text NOT NULL CHECK(password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[a-f0-9]{32}\$[a-f0-9]{128}$'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Failed attempts by normalized-email hash, whether or not an account exists,
-- so the limit reveals nothing about which addresses are registered.
CREATE TABLE IF NOT EXISTS member_password_failures (
 email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 failed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS member_password_failures_limit_idx
 ON member_password_failures(email_hash,failed_at DESC);
-- A fresh email-link sign-in lets that exact session set a new password
-- without the forgotten one, for 30 minutes and once.
CREATE TABLE IF NOT EXISTS member_password_reset_windows (
 principal_id uuid PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL
);
INSERT INTO schema_migrations(version) VALUES(89) ON CONFLICT DO NOTHING;
COMMIT;
