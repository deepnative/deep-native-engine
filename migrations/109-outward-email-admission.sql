BEGIN;
-- #42 The same fixed-window counts for mail sent to an address the caller names
-- and for password changes, which run the costly hash.
ALTER TABLE anonymous_write_windows DROP CONSTRAINT anonymous_write_windows_kind_check;
ALTER TABLE anonymous_write_windows ADD CONSTRAINT anonymous_write_windows_kind_check
 CHECK(kind IN ('signup','password_sign_in','email_attach','email_sign_in','password_change'));
INSERT INTO schema_migrations(version) VALUES(109) ON CONFLICT DO NOTHING;
COMMIT;
