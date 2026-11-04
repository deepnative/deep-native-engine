BEGIN;
-- #665 An email login request for an address no account uses sends that inbox
-- one "how to start" notice. Rows only count notices for the hourly limits;
-- they hold a hash, never the address, and no account reference.
CREATE TABLE IF NOT EXISTS member_email_notices (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS member_email_notices_limit_idx
 ON member_email_notices(created_at DESC, email_hash);
INSERT INTO schema_migrations(version) VALUES(93) ON CONFLICT DO NOTHING;
COMMIT;
