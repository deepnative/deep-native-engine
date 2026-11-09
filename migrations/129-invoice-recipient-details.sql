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
-- #796 SIGNEMAIL: the member's verified sign-in email kept readable beside its
-- unchanged fingerprint, as the default invoice email and in the member's own
-- records. A waiting email link holds the address only until it is used or
-- expires. Members verified earlier get theirs at their next email sign-in.
-- Rows still follow the account's deletion.
ALTER TABLE member_email_identities ADD COLUMN IF NOT EXISTS address text
 CHECK(address IS NULL OR length(address) BETWEEN 3 AND 254);
ALTER TABLE member_email_links ADD COLUMN IF NOT EXISTS address text
 CHECK(address IS NULL OR length(address) BETWEEN 3 AND 254);
CREATE OR REPLACE FUNCTION drop_used_email_link_address() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.consumed_at IS NOT NULL THEN NEW.address := NULL; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_email_link_address_used ON member_email_links;
CREATE TRIGGER member_email_link_address_used BEFORE INSERT OR UPDATE ON member_email_links
 FOR EACH ROW EXECUTE FUNCTION drop_used_email_link_address();
INSERT INTO schema_migrations(version) VALUES(129) ON CONFLICT DO NOTHING;
COMMIT;
