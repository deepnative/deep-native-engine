BEGIN;
-- #12 D08, owner decisions of 10 November 2026 (demo only, not legal or tax
-- advice). Deep Native Inc.'s tax year ends on 31 December. After the account
-- is deleted, an issued invoice and its payment records are kept until
-- 31 December six years after the tax year of the invoice date (an invoice
-- from 2026 is kept until 31 December 2032), then removed automatically.
-- Every migration re-runs at each start, so this file only adds or replaces.

-- When the account link was cleared. Older kept invoices have no recorded date.
ALTER TABLE simple_invoices ADD COLUMN IF NOT EXISTS owner_deleted_at timestamptz;

CREATE OR REPLACE FUNCTION simple_invoice_retained_until(document jsonb) RETURNS date
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT make_date(extract(year FROM (document->>'issuedOn')::date)::integer + 6, 12, 31)
$$;
CREATE OR REPLACE FUNCTION toronto_today() RETURNS date LANGUAGE sql STABLE AS $$
 SELECT (clock_timestamp() AT TIME ZONE 'America/Toronto')::date
$$;

CREATE OR REPLACE FUNCTION stamp_simple_invoice_owner_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN
  NEW.owner_deleted_at := clock_timestamp();
 ELSIF NEW.owner_deleted_at IS DISTINCT FROM OLD.owner_deleted_at THEN
  RAISE EXCEPTION 'Invoice deletion date is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_owner_deletion_stamp ON simple_invoices;
CREATE TRIGGER simple_invoice_owner_deletion_stamp BEFORE UPDATE ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION stamp_simple_invoice_owner_deletion();

-- Replaces the 082 guard: an issued invoice whose account is gone may now be
-- deleted once its retention has ended. Everything else is unchanged.
CREATE OR REPLACE FUNCTION guard_simple_invoice_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.owner_id IS NULL AND (OLD.sample OR simple_invoice_retained_until(OLD.document) < toronto_today()) THEN
   RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Issued invoice is retained';
 END IF;
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND NOT
  (NEW.owner_id IS NULL AND NOT EXISTS(SELECT 1 FROM learners WHERE id=OLD.owner_id))
 THEN RAISE EXCEPTION 'Invoice ownership cannot change'; END IF;
 RETURN NEW;
END $$;

-- RETEXP-03: one content-free row per removed invoice. No names, emails,
-- amounts or invoice numbers; the id no longer refers to anything.
CREATE TABLE IF NOT EXISTS simple_invoice_retention_removals (
 invoice_id uuid PRIMARY KEY,
 tax_year integer NOT NULL CHECK(tax_year BETWEEN 2000 AND 2200),
 retained_until date NOT NULL,
 owner_deleted_at timestamptz,
 payment_records integer NOT NULL CHECK(payment_records >= 0),
 removed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(retained_until < removed_at)
);
CREATE OR REPLACE FUNCTION preserve_invoice_retention_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Invoice removal records are immutable'; END $$;
DROP TRIGGER IF EXISTS invoice_retention_removal_immutable ON simple_invoice_retention_removals;
CREATE TRIGGER invoice_retention_removal_immutable BEFORE UPDATE OR DELETE ON simple_invoice_retention_removals
 FOR EACH ROW EXECUTE FUNCTION preserve_invoice_retention_removal();
CREATE INDEX IF NOT EXISTS simple_invoices_retained_unlinked ON simple_invoices(created_at)
 WHERE owner_id IS NULL AND NOT sample;

INSERT INTO schema_migrations(version) VALUES(136) ON CONFLICT DO NOTHING;
COMMIT;
