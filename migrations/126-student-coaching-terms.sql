BEGIN;
-- #316 owner decision 9 Nov 2026: an administrator sets each student's coaching
-- price, dates and allowances. Versions are immutable; the student's own price
-- covers the allowances, which are agreed numbers only (no ledger units, #27).
CREATE TABLE IF NOT EXISTS coaching_terms (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK(version>0),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 1000000000),
 starts_on date NOT NULL,
 ends_on date NOT NULL,
 renews_on date NOT NULL,
 review_minutes integer NOT NULL CHECK(review_minutes BETWEEN 0 AND 100000),
 coaching_sessions integer NOT NULL CHECK(coaching_sessions BETWEEN 0 AND 1000),
 ai_requests integer NOT NULL CHECK(ai_requests BETWEEN 0 AND 1000000),
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,version),
 UNIQUE(actor_id,operation_id),
 CHECK(ends_on>=starts_on),
 CHECK(renews_on>=starts_on)
);
DROP TRIGGER IF EXISTS coaching_terms_immutable ON coaching_terms;
CREATE TRIGGER coaching_terms_immutable BEFORE UPDATE OR DELETE ON coaching_terms
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();
INSERT INTO schema_migrations(version) VALUES(126) ON CONFLICT DO NOTHING;
COMMIT;
