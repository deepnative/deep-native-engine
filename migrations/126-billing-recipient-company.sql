BEGIN;
-- #796 RECIPIENT-04/05: an optional company name saved with the reusable
-- billing recipient, kept with a coaching draft and a course acceptance, and
-- printed on the invoice when set. NULL means none.
ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS company text
 CHECK(company IS NULL OR length(company) BETWEEN 1 AND 200);
ALTER TABLE coaching_months ADD COLUMN IF NOT EXISTS company text
 CHECK(company IS NULL OR length(company) BETWEEN 1 AND 200);
ALTER TABLE simple_invoice_plans ADD COLUMN IF NOT EXISTS recipient_company text
 CHECK(recipient_company IS NULL OR length(recipient_company) BETWEEN 1 AND 200);
INSERT INTO schema_migrations(version) VALUES(126) ON CONFLICT DO NOTHING;
COMMIT;
