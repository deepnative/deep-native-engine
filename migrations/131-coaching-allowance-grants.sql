BEGIN;
-- #27 with the owner's 9 Nov 2026 decision: the student's own coaching price
-- covers the allowances an administrator sets (#316). Each saved terms version
-- records the ledger grants it minted for its coaching period. Write-offs are
-- ordinary ledger adjust events on those grants.
CREATE TABLE IF NOT EXISTS coaching_allowance_grants (
 grant_id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 terms_id uuid NOT NULL REFERENCES coaching_terms(id) ON DELETE CASCADE,
 category text NOT NULL CHECK(category IN ('review_minutes','study_requests')),
 starts_on date NOT NULL,
 ends_on date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(grant_id,owner_id) REFERENCES synthetic_entitlement_grants(id,member_id) ON DELETE CASCADE,
 CHECK(ends_on>=starts_on)
);
CREATE INDEX IF NOT EXISTS coaching_allowance_grants_owner_idx
 ON coaching_allowance_grants(owner_id,category,starts_on);
DROP TRIGGER IF EXISTS coaching_allowance_grants_immutable ON coaching_allowance_grants;
CREATE TRIGGER coaching_allowance_grants_immutable BEFORE UPDATE OR DELETE ON coaching_allowance_grants
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();
INSERT INTO schema_migrations(version) VALUES(131) ON CONFLICT DO NOTHING;
COMMIT;
