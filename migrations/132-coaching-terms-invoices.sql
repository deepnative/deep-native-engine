BEGIN;
-- #318 under the owner's 9 Nov 2026 decisions: an administrator issues one
-- invoice for a student's coaching-terms version (#316, migration 126). One
-- invoice that isn't void per version; the link can't change once issued. No
-- foreign key: the terms leave with a deleted account, the invoice is retained
-- and its document keeps the version and dates. Staff change history logs the
-- issue as coaching_invoice_issued with no month, so its action list is unchanged.
ALTER TABLE simple_invoices ADD COLUMN IF NOT EXISTS coaching_terms_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS simple_invoice_one_terms_version
 ON simple_invoices(coaching_terms_id)
 WHERE coaching_terms_id IS NOT NULL AND void_reason IS NULL;
CREATE OR REPLACE FUNCTION preserve_coaching_terms_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.coaching_terms_id IS DISTINCT FROM OLD.coaching_terms_id THEN RAISE EXCEPTION 'Invoiced coaching terms are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS coaching_terms_invoice_immutable ON simple_invoices;
CREATE TRIGGER coaching_terms_invoice_immutable BEFORE UPDATE OF coaching_terms_id ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_terms_invoice();
INSERT INTO schema_migrations(version) VALUES(132) ON CONFLICT DO NOTHING;
COMMIT;
