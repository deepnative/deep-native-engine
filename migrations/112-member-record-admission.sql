BEGIN;
-- #42 The same fixed-window counts for a signed-in member creating a new private
-- text record: milestones, career entries and drafts, and contribution proposals.
ALTER TABLE anonymous_write_windows DROP CONSTRAINT anonymous_write_windows_kind_check;
ALTER TABLE anonymous_write_windows ADD CONSTRAINT anonymous_write_windows_kind_check
 CHECK(kind IN ('signup','password_sign_in','email_attach','email_sign_in','password_change','member_record'));
INSERT INTO schema_migrations(version) VALUES(112) ON CONFLICT DO NOTHING;
COMMIT;
