BEGIN;
-- Requests retain references and bounded choices, never another copy of text.
CREATE TABLE IF NOT EXISTS preview_circle_appeals (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 circle_id text NOT NULL,
 post_id uuid NOT NULL,
 decision_revision integer NOT NULL CHECK(decision_revision>1),
 request_reason text NOT NULL CHECK(request_reason IN ('recheck_rule','missing_context','other')),
 idempotency_key uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','withdrawn','upheld','restored')),
 closed_at timestamptz,
 resolver_id uuid,
 resolver_role text,
 resolution_key uuid,
 resolution_fingerprint text,
 resolution_reason text,
 resolved_revision integer,
 UNIQUE(member_id,idempotency_key),
 UNIQUE(post_id,decision_revision),
 UNIQUE(resolver_id,resolution_key),
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 FOREIGN KEY(post_id,member_id,circle_id) REFERENCES preview_circle_posts(id,member_id,circle_id) ON DELETE CASCADE,
 FOREIGN KEY(post_id,decision_revision) REFERENCES preview_circle_moderation_audit(post_id,new_revision) ON DELETE CASCADE,
 CHECK(closed_at IS NULL OR closed_at>=requested_at),
 CHECK(
  (state IN ('pending','withdrawn') AND resolver_id IS NULL AND resolver_role IS NULL
   AND resolution_key IS NULL AND resolution_fingerprint IS NULL AND resolution_reason IS NULL
   AND resolved_revision IS NULL AND ((state='pending' AND closed_at IS NULL) OR (state='withdrawn' AND closed_at IS NOT NULL)))
  OR
  (state IN ('upheld','restored') AND closed_at IS NOT NULL AND resolver_id IS NOT NULL
   AND resolver_role IS NOT NULL AND resolver_role IN ('moderator','platform_admin')
   AND resolution_key IS NOT NULL AND resolution_fingerprint IS NOT NULL
   AND resolution_fingerprint ~ '^[a-f0-9]{64}$' AND resolution_reason IS NOT NULL
   AND resolved_revision IS NOT NULL
   AND ((state='upheld' AND resolution_reason='rule_applies' AND resolved_revision=decision_revision)
     OR (state='restored' AND resolution_reason='decision_corrected' AND resolved_revision=decision_revision+1)))
 )
);
CREATE INDEX IF NOT EXISTS preview_circle_appeal_owner_idx ON preview_circle_appeals(member_id,circle_id,id);
CREATE INDEX IF NOT EXISTS preview_circle_appeal_pending_idx ON preview_circle_appeals(circle_id,id) WHERE state='pending';

CREATE OR REPLACE FUNCTION guard_preview_circle_appeal() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Circle appeal records require owner erasure';
 END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(7529,hashtext(NEW.circle_id));
  IF NEW.state<>'pending' OR NOT EXISTS(
   SELECT 1 FROM preview_circle_moderation_audit a JOIN preview_circle_posts p ON p.id=a.post_id
   WHERE a.post_id=NEW.post_id AND a.new_revision=NEW.decision_revision AND a.action='hidden'
    AND a.member_id=NEW.member_id AND a.workspace_id=NEW.workspace_id AND a.circle_id=NEW.circle_id
    AND p.member_id=NEW.member_id AND p.circle_id=NEW.circle_id AND p.state='hidden' AND p.revision=a.new_revision
  ) THEN RAISE EXCEPTION 'Circle appeal requires the exact current hidden decision'; END IF;
  IF (SELECT count(*) FROM preview_circle_appeals WHERE member_id=NEW.member_id AND circle_id=NEW.circle_id)>=200 THEN
   RAISE EXCEPTION 'Circle retained-appeal bound reached';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.member_id,NEW.workspace_id,NEW.circle_id,NEW.post_id,NEW.decision_revision,
     NEW.request_reason,NEW.idempotency_key,NEW.fingerprint,NEW.requested_at)
  IS DISTINCT FROM
    (OLD.id,OLD.member_id,OLD.workspace_id,OLD.circle_id,OLD.post_id,OLD.decision_revision,
     OLD.request_reason,OLD.idempotency_key,OLD.fingerprint,OLD.requested_at)
  OR OLD.state<>'pending' OR NEW.state='pending' THEN
  RAISE EXCEPTION 'Circle appeal identity and terminal result are immutable';
 END IF;
 IF NEW.state='withdrawn' THEN RETURN NEW; END IF;
 IF NEW.state='upheld' AND NOT EXISTS(
  SELECT 1 FROM preview_circle_posts p WHERE p.id=NEW.post_id AND p.state='hidden' AND p.revision=NEW.decision_revision
 ) THEN RAISE EXCEPTION 'Circle appeal cannot uphold a newer source state'; END IF;
 IF NEW.state='restored' AND NOT EXISTS(
  SELECT 1 FROM preview_circle_moderation_audit a JOIN preview_circle_posts p ON p.id=a.post_id
  WHERE a.post_id=NEW.post_id AND a.old_revision=NEW.decision_revision AND a.new_revision=NEW.resolved_revision
   AND a.action='restored' AND a.reason='test_correction' AND a.actor_id=NEW.resolver_id AND a.actor_role=NEW.resolver_role
   AND a.idempotency_key=NEW.resolution_key AND a.fingerprint=NEW.resolution_fingerprint
   AND p.state='visible' AND p.revision=a.new_revision AND a.occurred_at<=NEW.closed_at
 ) THEN RAISE EXCEPTION 'Circle appeal correction requires its atomic restoration audit'; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_appeal_guard ON preview_circle_appeals;
CREATE TRIGGER preview_circle_appeal_guard BEFORE INSERT OR UPDATE OR DELETE ON preview_circle_appeals
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_appeal();
INSERT INTO schema_migrations(version) VALUES(76) ON CONFLICT DO NOTHING;
COMMIT;
