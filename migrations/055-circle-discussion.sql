BEGIN;
-- Existing membership conveys no new permission. Advance generation only on
-- a genuine later join; choices pin a generation without rewriting old history.
ALTER TABLE preview_circle_memberships
 ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1 CHECK(generation>0);

-- Archive only observed closed intervals. Pre-migration unknown intervals cannot
-- be reconstructed; the current legacy closed interval is retained as generation 1.
CREATE TABLE IF NOT EXISTS preview_circle_membership_history (
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 circle_id text NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 joined_at timestamptz NOT NULL,
 left_at timestamptz NOT NULL CHECK(left_at>=joined_at),
 PRIMARY KEY(member_id,circle_id,generation),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
INSERT INTO preview_circle_membership_history(member_id,workspace_id,circle_id,generation,joined_at,left_at)
 SELECT m.member_id,w.id,m.circle_id,m.generation,m.joined_at,m.left_at
 FROM preview_circle_memberships m JOIN workspaces w ON w.owner_principal_id=m.member_id
 WHERE m.left_at IS NOT NULL ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION guard_preview_circle_membership_transition() RETURNS trigger AS $$
BEGIN
 IF NEW.member_id<>OLD.member_id OR NEW.circle_id<>OLD.circle_id THEN
  RAISE EXCEPTION 'Circle membership identity is immutable';
 END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
    AND NEW.generation=OLD.generation AND NEW.joined_at=OLD.joined_at THEN
  RETURN NEW;
 END IF;
 IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL
    AND NEW.generation=OLD.generation+1 AND NEW.joined_at>=OLD.left_at THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Circle membership transition requires a fresh generation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_membership_transition ON preview_circle_memberships;
CREATE TRIGGER preview_circle_membership_transition BEFORE UPDATE ON preview_circle_memberships
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_membership_transition();
CREATE OR REPLACE FUNCTION retain_preview_circle_closed_interval() RETURNS trigger AS $$
BEGIN
 IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
  INSERT INTO preview_circle_membership_history(member_id,workspace_id,circle_id,generation,joined_at,left_at)
   SELECT NEW.member_id,w.id,NEW.circle_id,NEW.generation,NEW.joined_at,NEW.left_at
   FROM workspaces w WHERE w.owner_principal_id=NEW.member_id;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_membership_closed_interval ON preview_circle_memberships;
CREATE TRIGGER preview_circle_membership_closed_interval AFTER UPDATE ON preview_circle_memberships
 FOR EACH ROW EXECUTE FUNCTION retain_preview_circle_closed_interval();
CREATE OR REPLACE FUNCTION guard_preview_circle_membership_history() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM preview_circle_memberships m WHERE m.member_id=NEW.member_id
    AND m.circle_id=NEW.circle_id AND m.generation=NEW.generation
    AND m.joined_at=NEW.joined_at AND m.left_at=NEW.left_at) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Circle membership history is an immutable observed interval';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_membership_history_guard ON preview_circle_membership_history;
CREATE TRIGGER preview_circle_membership_history_guard BEFORE INSERT OR UPDATE OR DELETE ON preview_circle_membership_history
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_membership_history();

CREATE TABLE IF NOT EXISTS preview_circle_choices (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 circle_id text NOT NULL CHECK(circle_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
 generation bigint NOT NULL CHECK(generation>0),
 policy_version text NOT NULL CHECK(policy_version='circle-discussion-test-v1'),
 pseudonym text NOT NULL CHECK(pseudonym ~ '^Peer [a-f0-9]{16}$'),
 idempotency_key uuid NOT NULL,
 chosen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 UNIQUE(id,member_id,circle_id),
 UNIQUE(member_id,idempotency_key),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 CHECK(revoked_at IS NULL OR revoked_at>=chosen_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS preview_circle_choice_current_idx
 ON preview_circle_choices(circle_id,member_id,generation) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS preview_circle_choice_owner_idx ON preview_circle_choices(member_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_choice_workspace_idx ON preview_circle_choices(workspace_id,id);

CREATE TABLE IF NOT EXISTS preview_circle_posts (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 circle_id text NOT NULL,
 choice_id uuid NOT NULL,
 -- Historical foreign-root reference only. No cross-owner FK/cascade: erasing
 -- the root author must not delete the reply author's independently owned text.
 root_id uuid,
 body text,
 state text NOT NULL DEFAULT 'visible' CHECK(state IN ('visible','hidden','withdrawn')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 idempotency_key uuid NOT NULL,
 fingerprint text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 UNIQUE(id,member_id,circle_id),
 UNIQUE(member_id,idempotency_key),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(choice_id,member_id,circle_id) REFERENCES preview_circle_choices(id,member_id,circle_id) ON DELETE CASCADE,
 CHECK(root_id IS NULL OR root_id<>id),
 CHECK((state='withdrawn' AND body IS NULL AND fingerprint IS NULL AND withdrawn_at IS NOT NULL)
    OR (state IN ('visible','hidden') AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000
        AND fingerprint IS NOT NULL AND fingerprint ~ '^[a-f0-9]{64}$' AND withdrawn_at IS NULL)),
 CHECK(changed_at>=created_at),
 CHECK(withdrawn_at IS NULL OR withdrawn_at>=created_at)
);
CREATE INDEX IF NOT EXISTS preview_circle_post_owner_count_idx ON preview_circle_posts(member_id,circle_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_post_workspace_idx ON preview_circle_posts(workspace_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_post_candidate_idx ON preview_circle_posts(circle_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_reply_idx ON preview_circle_posts(circle_id,root_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_post_choice_idx ON preview_circle_posts(choice_id,id);

CREATE TABLE IF NOT EXISTS preview_circle_reports (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 circle_id text NOT NULL,
 -- Content-free historical target; never a snapshot or an access capability.
 target_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN ('privacy','conduct','off_topic','other')),
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(member_id,idempotency_key),
 UNIQUE(member_id,target_id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS preview_circle_report_owner_idx ON preview_circle_reports(member_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_report_workspace_idx ON preview_circle_reports(workspace_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_report_queue_idx ON preview_circle_reports(circle_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_report_target_idx ON preview_circle_reports(circle_id,target_id,id);

CREATE TABLE IF NOT EXISTS preview_circle_moderator_grants (
 id uuid PRIMARY KEY,
 staff_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 staff_role text NOT NULL CHECK(staff_role IN ('moderator','platform_admin')),
 circle_id text NOT NULL CHECK(circle_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
 purpose text NOT NULL CHECK(purpose='circle-discussion-test-v1'),
 granted_by uuid NOT NULL,
 idempotency_key uuid NOT NULL UNIQUE,
 starts_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 CHECK(expires_at>starts_at)
);
CREATE INDEX IF NOT EXISTS preview_circle_grant_scope_idx ON preview_circle_moderator_grants(staff_id,circle_id,id);

CREATE TABLE IF NOT EXISTS preview_circle_grant_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 staff_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 circle_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('created','revoked')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS preview_circle_grant_audit_idx ON preview_circle_grant_audit(grant_id,id);

CREATE TABLE IF NOT EXISTS preview_circle_moderation_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 actor_role text NOT NULL CHECK(actor_role IN ('moderator','platform_admin')),
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 circle_id text NOT NULL,
 post_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('hidden','restored')),
 reason text NOT NULL CHECK(reason IN ('privacy','conduct','off_topic','test_correction')),
 old_revision integer NOT NULL CHECK(old_revision>0),
 new_revision integer NOT NULL,
 idempotency_key uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,idempotency_key),
 UNIQUE(post_id,new_revision),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(post_id,member_id,circle_id) REFERENCES preview_circle_posts(id,member_id,circle_id) ON DELETE CASCADE,
 CHECK(new_revision=old_revision+1)
);
CREATE INDEX IF NOT EXISTS preview_circle_moderation_owner_idx ON preview_circle_moderation_audit(workspace_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_moderation_post_idx ON preview_circle_moderation_audit(post_id,id);
-- Keep append-only/content identity guards tied to the actual owning workspace,
-- never a cross-owner or membership cascade. Other owners keep independent rows.
CREATE OR REPLACE FUNCTION guard_preview_circle_owned_record() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   RAISE EXCEPTION 'Circle owned records require owner erasure';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='preview_circle_choices' THEN
  IF (NEW.id,NEW.member_id,NEW.workspace_id,NEW.circle_id,NEW.generation,NEW.policy_version,
      NEW.pseudonym,NEW.idempotency_key,NEW.chosen_at)
    IS DISTINCT FROM
     (OLD.id,OLD.member_id,OLD.workspace_id,OLD.circle_id,OLD.generation,OLD.policy_version,
      OLD.pseudonym,OLD.idempotency_key,OLD.chosen_at)
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
   RAISE EXCEPTION 'Circle choice identity is immutable';
  END IF;
 ELSIF TG_TABLE_NAME='preview_circle_posts' THEN
  IF (NEW.id,NEW.member_id,NEW.workspace_id,NEW.circle_id,NEW.choice_id,NEW.root_id,
      NEW.idempotency_key,NEW.created_at)
    IS DISTINCT FROM
     (OLD.id,OLD.member_id,OLD.workspace_id,OLD.circle_id,OLD.choice_id,OLD.root_id,
      OLD.idempotency_key,OLD.created_at)
    OR OLD.state='withdrawn' OR NEW.revision<>OLD.revision+1 OR NEW.changed_at<OLD.changed_at
    OR NEW.state=OLD.state THEN
   RAISE EXCEPTION 'Circle item identity and state transition are immutable';
  END IF;
  IF NEW.state<>'withdrawn' AND (NEW.body,NEW.fingerprint,NEW.withdrawn_at)
    IS DISTINCT FROM (OLD.body,OLD.fingerprint,OLD.withdrawn_at) THEN
   RAISE EXCEPTION 'Circle text requires explicit withdrawal';
  END IF;
 ELSE
  RAISE EXCEPTION 'Circle history is immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_choice_guard ON preview_circle_choices;
CREATE TRIGGER preview_circle_choice_guard BEFORE UPDATE OR DELETE ON preview_circle_choices
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_owned_record();
DROP TRIGGER IF EXISTS preview_circle_post_guard ON preview_circle_posts;
CREATE TRIGGER preview_circle_post_guard BEFORE UPDATE OR DELETE ON preview_circle_posts
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_owned_record();
DROP TRIGGER IF EXISTS preview_circle_report_guard ON preview_circle_reports;
CREATE TRIGGER preview_circle_report_guard BEFORE UPDATE OR DELETE ON preview_circle_reports
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_owned_record();
DROP TRIGGER IF EXISTS preview_circle_moderation_guard ON preview_circle_moderation_audit;
CREATE TRIGGER preview_circle_moderation_guard BEFORE UPDATE OR DELETE ON preview_circle_moderation_audit
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_owned_record();
CREATE OR REPLACE FUNCTION reject_preview_circle_grant_audit_mutation() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'Circle grant history is immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_grant_audit_guard ON preview_circle_grant_audit;
CREATE TRIGGER preview_circle_grant_audit_guard BEFORE UPDATE OR DELETE ON preview_circle_grant_audit
 FOR EACH ROW EXECUTE FUNCTION reject_preview_circle_grant_audit_mutation();
CREATE OR REPLACE FUNCTION validate_preview_circle_moderation_attachment() RETURNS trigger AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM preview_circle_posts p WHERE p.id=NEW.post_id
   AND p.member_id=NEW.member_id AND p.workspace_id=NEW.workspace_id AND p.circle_id=NEW.circle_id
   AND p.revision=NEW.new_revision AND p.state=CASE NEW.action WHEN 'hidden' THEN 'hidden' ELSE 'visible' END) THEN
  RAISE EXCEPTION 'Circle moderation audit requires its exact state transition';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_moderation_attachment ON preview_circle_moderation_audit;
CREATE TRIGGER preview_circle_moderation_attachment BEFORE INSERT ON preview_circle_moderation_audit
 FOR EACH ROW EXECUTE FUNCTION validate_preview_circle_moderation_attachment();
CREATE OR REPLACE FUNCTION enforce_preview_circle_post_bound() RETURNS trigger AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(7529,hashtext(NEW.circle_id));
 IF (SELECT count(*) FROM preview_circle_posts WHERE member_id=NEW.member_id AND circle_id=NEW.circle_id)>=200 THEN
  RAISE EXCEPTION 'Circle retained-item bound reached';
 END IF;
 IF NEW.root_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM preview_circle_posts WHERE id=NEW.root_id
    AND circle_id=NEW.circle_id AND root_id IS NULL AND state='visible') THEN
   RAISE EXCEPTION 'Circle reply root unavailable';
  END IF;
  IF (SELECT count(*) FROM preview_circle_posts WHERE root_id=NEW.root_id AND circle_id=NEW.circle_id)>=100 THEN
   RAISE EXCEPTION 'Circle retained-reply bound reached';
  END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_post_bound ON preview_circle_posts;
CREATE TRIGGER preview_circle_post_bound BEFORE INSERT ON preview_circle_posts
 FOR EACH ROW EXECUTE FUNCTION enforce_preview_circle_post_bound();
CREATE OR REPLACE FUNCTION validate_preview_circle_report_target() RETURNS trigger AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(7529,hashtext(NEW.circle_id));
 IF NOT EXISTS(SELECT 1 FROM preview_circle_posts p WHERE p.id=NEW.target_id AND p.circle_id=NEW.circle_id AND p.state='visible'
   AND (p.root_id IS NULL OR EXISTS(SELECT 1 FROM preview_circle_posts r
    WHERE r.id=p.root_id AND r.circle_id=p.circle_id AND r.root_id IS NULL AND r.state='visible'))) THEN
  RAISE EXCEPTION 'Circle report target unavailable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_report_target ON preview_circle_reports;
CREATE TRIGGER preview_circle_report_target BEFORE INSERT ON preview_circle_reports
 FOR EACH ROW EXECUTE FUNCTION validate_preview_circle_report_target();
INSERT INTO schema_migrations(version) VALUES(55) ON CONFLICT DO NOTHING;
COMMIT;
