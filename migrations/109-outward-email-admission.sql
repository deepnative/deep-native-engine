BEGIN;
-- #42 The same fixed-window counts for mail sent to an address the caller names
-- and for password changes, which run the costly hash.
-- Every migration re-runs at each start; 111 widens this, and its rows must survive a restart.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=111) THEN
ALTER TABLE anonymous_write_windows DROP CONSTRAINT anonymous_write_windows_kind_check;
ALTER TABLE anonymous_write_windows ADD CONSTRAINT anonymous_write_windows_kind_check
 CHECK(kind IN ('signup','password_sign_in','email_attach','email_sign_in','password_change'));
END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(109) ON CONFLICT DO NOTHING;
COMMIT;
