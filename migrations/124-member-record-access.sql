BEGIN;
-- #40 RECACCESS: a member lets operators download one scope of their records
-- for at most seven days. A revocation is recorded once; nothing else changes.
CREATE TABLE IF NOT EXISTS member_record_access (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 scope text NOT NULL CHECK(scope IN ('learning','support','billing')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX IF NOT EXISTS member_record_access_member ON member_record_access(member_id,scope,expires_at);
-- One line per download an operator made under an authorization. The staff
-- principal is kept for accountability; the member never sees who it was.
CREATE TABLE IF NOT EXISTS member_record_access_downloads (
 id uuid PRIMARY KEY,
 access_id uuid NOT NULL REFERENCES member_record_access(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 staff_id uuid NOT NULL,
 scope text NOT NULL CHECK(scope IN ('learning','support','billing')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS member_record_access_downloads_member ON member_record_access_downloads(member_id,occurred_at);
CREATE OR REPLACE FUNCTION guard_member_record_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 -- The rows go only with the member's account.
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Record access history is retained';
 END IF;
 IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
  AND (NEW.id,NEW.member_id,NEW.scope,NEW.created_at,NEW.expires_at)
   IS NOT DISTINCT FROM (OLD.id,OLD.member_id,OLD.scope,OLD.created_at,OLD.expires_at)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Record access can only be revoked once';
END $$;
DROP TRIGGER IF EXISTS member_record_access_guard ON member_record_access;
CREATE TRIGGER member_record_access_guard BEFORE UPDATE OR DELETE ON member_record_access
 FOR EACH ROW EXECUTE FUNCTION guard_member_record_access();
CREATE OR REPLACE FUNCTION guard_member_record_access_download() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.occurred_at=clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM member_record_access a WHERE a.id=NEW.access_id
   AND a.member_id=NEW.member_id AND a.scope=NEW.scope AND a.revoked_at IS NULL
   AND a.created_at<=NEW.occurred_at AND a.expires_at>NEW.occurred_at)
  THEN RAISE EXCEPTION 'A download needs current record access'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Record access downloads are immutable';
END $$;
DROP TRIGGER IF EXISTS member_record_access_download_guard ON member_record_access_downloads;
CREATE TRIGGER member_record_access_download_guard BEFORE INSERT OR UPDATE OR DELETE ON member_record_access_downloads
 FOR EACH ROW EXECUTE FUNCTION guard_member_record_access_download();
INSERT INTO schema_migrations(version) VALUES(124) ON CONFLICT DO NOTHING;
COMMIT;
