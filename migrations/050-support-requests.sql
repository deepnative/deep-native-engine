BEGIN;
CREATE TABLE IF NOT EXISTS support_requests (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,
 intake_key uuid NOT NULL,
 subject text CHECK(char_length(subject)+regexp_count(subject COLLATE "C", U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 120),
 body text CHECK(char_length(body)+regexp_count(body COLLATE "C", U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 2000),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 acknowledged_by uuid,
 acknowledged_at timestamptz,
 resolved_by uuid,
 resolved_at timestamptz,
 withdrawn_at timestamptz,
 coverage_state text NOT NULL DEFAULT 'unverified' CHECK(coverage_state='unverified'),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 UNIQUE(member_id,intake_key),
 CHECK((acknowledged_by IS NULL)=(acknowledged_at IS NULL)),
 CHECK((resolved_by IS NULL)=(resolved_at IS NULL)),
 CHECK((withdrawn_at IS NULL AND subject IS NOT NULL AND body IS NOT NULL
        AND length(btrim(subject))>0 AND length(btrim(body))>0)
    OR (withdrawn_at IS NOT NULL AND subject IS NULL AND body IS NULL))
);
CREATE INDEX IF NOT EXISTS support_requests_owner_history_idx ON support_requests(member_id,received_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS support_request_grants (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 staff_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 staff_role text NOT NULL CHECK(staff_role IN ('operator','platform_admin')),
 purpose text NOT NULL DEFAULT 'support-request-local-v1' CHECK(purpose='support-request-local-v1'),
 starts_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 granted_by uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(granted_by,idempotency_key),
 CHECK(expires_at>starts_at)
);
CREATE INDEX IF NOT EXISTS support_request_grants_actor_idx ON support_request_grants(staff_id,request_id,id);
CREATE TABLE IF NOT EXISTS support_request_replies (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 body text NOT NULL CHECK(length(btrim(body))>0 AND char_length(body)+regexp_count(body COLLATE "C", U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS support_request_replies_page_idx ON support_request_replies(request_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS support_request_notes (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 body text NOT NULL CHECK(length(btrim(body))>0 AND char_length(body)+regexp_count(body COLLATE "C", U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS support_request_notes_page_idx ON support_request_notes(request_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS support_request_events (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 grant_id uuid,
 message_id uuid,
 action text NOT NULL CHECK(action IN ('received','acknowledged','replied','noted','resolved','withdrawn','detail-read','worklist-read','grant-created','grant-revoked')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS support_request_mutations (
 request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('acknowledged','replied','noted','resolved')),
 idempotency_key uuid NOT NULL,
 event_id uuid NOT NULL,
 message_id uuid,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(request_id,actor_id,action,idempotency_key),
 CHECK((action IN ('replied','noted'))=(message_id IS NOT NULL))
);
-- Actor/admin IDs in historical records deliberately have no foreign keys.
-- They neither grant access nor introduce later locks on another principal.
CREATE OR REPLACE FUNCTION preserve_support_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['subject','body','acknowledged_by','acknowledged_at','resolved_by','resolved_at','withdrawn_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','body','acknowledged_by','acknowledged_at','resolved_by','resolved_at','withdrawn_at'])
    OR (OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at,NEW.acknowledged_by) IS DISTINCT FROM (OLD.acknowledged_at,OLD.acknowledged_by))
    OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at,NEW.resolved_by,NEW.acknowledged_at,NEW.acknowledged_by) IS DISTINCT FROM (OLD.resolved_at,OLD.resolved_by,OLD.acknowledged_at,OLD.acknowledged_by))
    OR (OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    OR (NEW.withdrawn_at IS NULL AND (NEW.subject,NEW.body) IS DISTINCT FROM (OLD.subject,OLD.body)) THEN
  RAISE EXCEPTION 'Support request history is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_requests_immutable ON support_requests;
CREATE TRIGGER support_requests_immutable BEFORE UPDATE ON support_requests FOR EACH ROW EXECUTE FUNCTION preserve_support_request();
CREATE OR REPLACE FUNCTION preserve_support_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
  RAISE EXCEPTION 'Support grant history is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_request_grants_immutable ON support_request_grants;
CREATE TRIGGER support_request_grants_immutable BEFORE UPDATE ON support_request_grants FOR EACH ROW EXECUTE FUNCTION preserve_support_grant();
CREATE OR REPLACE FUNCTION preserve_support_append_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Support append records are immutable'; END $$;
DROP TRIGGER IF EXISTS support_request_replies_immutable ON support_request_replies;
CREATE TRIGGER support_request_replies_immutable BEFORE UPDATE ON support_request_replies FOR EACH ROW EXECUTE FUNCTION preserve_support_append_record();
DROP TRIGGER IF EXISTS support_request_notes_immutable ON support_request_notes;
CREATE TRIGGER support_request_notes_immutable BEFORE UPDATE ON support_request_notes FOR EACH ROW EXECUTE FUNCTION preserve_support_append_record();
DROP TRIGGER IF EXISTS support_request_mutations_immutable ON support_request_mutations;
CREATE TRIGGER support_request_mutations_immutable BEFORE UPDATE ON support_request_mutations FOR EACH ROW EXECUTE FUNCTION preserve_support_append_record();
CREATE OR REPLACE FUNCTION preserve_support_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM support_requests WHERE id=OLD.request_id) THEN
  RAISE EXCEPTION 'Support event history is immutable';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS support_request_events_immutable ON support_request_events;
CREATE TRIGGER support_request_events_immutable BEFORE UPDATE OR DELETE ON support_request_events FOR EACH ROW EXECUTE FUNCTION preserve_support_event();
INSERT INTO schema_migrations(version) VALUES(50) ON CONFLICT DO NOTHING;
COMMIT;
