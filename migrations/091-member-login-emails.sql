BEGIN;
-- #637 Sign up with email and password, verify later. Holds the hash of a
-- member's not-yet-verified sign-in email. Verifying that address (or using an
-- email sign-in link for it) moves it to member_email_identities, and any
-- other account's unverified claim to the same address is removed.
CREATE TABLE IF NOT EXISTS member_login_emails (
 email_hash text PRIMARY KEY CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 principal_id uuid NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO schema_migrations(version) VALUES(91) ON CONFLICT DO NOTHING;
COMMIT;
