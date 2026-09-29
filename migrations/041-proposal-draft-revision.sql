BEGIN;
-- Existing private proposals start at revision 1; only current text is kept.
ALTER TABLE member_proposals
 ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1
 CHECK(revision > 0);
INSERT INTO schema_migrations(version) VALUES(41) ON CONFLICT DO NOTHING;
COMMIT;
