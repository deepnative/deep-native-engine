BEGIN;
CREATE TABLE IF NOT EXISTS member_email_identities (
 email_hash text PRIMARY KEY CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 principal_id uuid NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS member_email_links (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(purpose IN ('attach','sign_in')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS member_email_links_request_limit_idx
 ON member_email_links(email_hash,created_at DESC);
CREATE INDEX IF NOT EXISTS member_email_links_principal_limit_idx
 ON member_email_links(principal_id,created_at DESC);
INSERT INTO schema_migrations(version) VALUES(73) ON CONFLICT DO NOTHING;
COMMIT;
