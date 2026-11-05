BEGIN;
-- #687 A Diagnostics email lookup shows an account's name and activity, so each
-- one leaves a record. Rows hold the address hash, never the address. staff_id
-- has no foreign key, so a record outlives the administrator session it names.
CREATE TABLE IF NOT EXISTS administrator_email_lookups (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 staff_id uuid NOT NULL,
 email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS administrator_email_lookups_time_idx
 ON administrator_email_lookups(occurred_at DESC);
INSERT INTO schema_migrations(version) VALUES(96) ON CONFLICT DO NOTHING;
COMMIT;
