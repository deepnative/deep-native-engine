BEGIN;
CREATE TABLE IF NOT EXISTS coaching_rates (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 effective_month text NOT NULL CHECK(effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 cents integer NOT NULL CHECK(cents BETWEEN 1 AND 1000000000),
 version integer NOT NULL CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,version)
);
CREATE TABLE IF NOT EXISTS coaching_submissions (
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 month text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,month,revision)
);
CREATE TABLE IF NOT EXISTS coaching_months (
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 month text NOT NULL CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 minutes integer NOT NULL CHECK(minutes BETWEEN 0 AND 44640),
 name text NOT NULL,
 email text NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','submitted','invoiced')),
 revision integer NOT NULL CHECK(revision>0),
 submitted_revision integer,
 invoice_id uuid REFERENCES simple_invoices(id) ON DELETE SET NULL,
 previous_invoice_id uuid REFERENCES simple_invoices(id) ON DELETE SET NULL,
 return_reason text,
 PRIMARY KEY(owner_id,month),
 CHECK(state='draft' OR submitted_revision IS NOT NULL)
);
ALTER TABLE simple_invoices ADD COLUMN IF NOT EXISTS coaching_month text
 CHECK(coaching_month IS NULL OR coaching_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
CREATE UNIQUE INDEX IF NOT EXISTS simple_invoice_one_coaching_month
 ON simple_invoices(owner_id,coaching_month)
 WHERE coaching_month IS NOT NULL AND void_reason IS NULL;
CREATE OR REPLACE FUNCTION preserve_coaching_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM learners WHERE id=OLD.owner_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Coaching history is immutable';
END $$;
DROP TRIGGER IF EXISTS coaching_rate_immutable ON coaching_rates;
CREATE TRIGGER coaching_rate_immutable BEFORE UPDATE OR DELETE ON coaching_rates
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();
DROP TRIGGER IF EXISTS coaching_submission_immutable ON coaching_submissions;
CREATE TRIGGER coaching_submission_immutable BEFORE UPDATE OR DELETE ON coaching_submissions
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();
CREATE OR REPLACE FUNCTION preserve_coaching_invoice_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.coaching_month IS DISTINCT FROM OLD.coaching_month THEN RAISE EXCEPTION 'Issued coaching month is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS coaching_invoice_month_immutable ON simple_invoices;
CREATE TRIGGER coaching_invoice_month_immutable BEFORE UPDATE OF coaching_month ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_invoice_month();
INSERT INTO schema_migrations(version) VALUES(84) ON CONFLICT DO NOTHING;
COMMIT;
