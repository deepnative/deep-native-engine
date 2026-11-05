BEGIN;
-- #693 At most three no-account notices per visitor per hour. A row only counts
-- towards that limit: it holds a hash keyed with a value that never reaches the
-- database, never the visitor's address, and nothing that links it to an inbox.
CREATE TABLE IF NOT EXISTS member_email_notice_visitors (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 visitor_hash text NOT NULL CHECK(visitor_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS member_email_notice_visitors_limit_idx
 ON member_email_notice_visitors(visitor_hash, created_at);
INSERT INTO schema_migrations(version) VALUES(97) ON CONFLICT DO NOTHING;
COMMIT;
