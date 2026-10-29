BEGIN;
-- Legacy sample attestations are never converted into ordinary or sharing consent.
ALTER TABLE member_proposals ALTER COLUMN sample_attested_at DROP NOT NULL;
ALTER TABLE member_proposals ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'sample';
ALTER TABLE member_proposals DROP CONSTRAINT IF EXISTS member_proposals_origin_check;
ALTER TABLE member_proposals ADD CONSTRAINT member_proposals_origin_check CHECK
 ((origin='sample' AND sample_attested_at IS NOT NULL) OR (origin='member' AND sample_attested_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS member_proposals_owner_key ON member_proposals(id,member_id);

-- No proposal text is copied into the immutable curriculum catalog. This owned
-- record identifies the accepted revision; every display also locks its source.
CREATE TABLE IF NOT EXISTS proposal_publications (
 id uuid PRIMARY KEY,
 proposal_id uuid NOT NULL,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 accepted_by uuid NOT NULL,
 accepted_role text NOT NULL CHECK(accepted_role IN ('moderator','platform_admin')),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','published','withdrawn')),
 operation_id uuid UNIQUE,
 attribution text,
 audience text CHECK(audience='members'),
 permission_version text CHECK(permission_version='member-display-v1'),
 published_at timestamptz,
 withdrawn_at timestamptz,
 UNIQUE(proposal_id,revision),
 FOREIGN KEY(proposal_id,member_id) REFERENCES member_proposals(id,member_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 CHECK((operation_id IS NULL AND audience IS NULL AND permission_version IS NULL AND published_at IS NULL)
    OR (operation_id IS NOT NULL AND audience IS NOT NULL AND permission_version IS NOT NULL AND published_at IS NOT NULL)),
 CHECK((state='accepted' AND operation_id IS NULL AND attribution IS NULL AND withdrawn_at IS NULL)
    OR (state='published' AND operation_id IS NOT NULL AND attribution IS NOT NULL AND length(btrim(attribution)) BETWEEN 1 AND 80 AND withdrawn_at IS NULL)
    OR (state='withdrawn' AND attribution IS NULL AND withdrawn_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS proposal_publications_owner_idx ON proposal_publications(member_id,id);
CREATE OR REPLACE FUNCTION guard_proposal_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'accepted' OR NOT EXISTS(SELECT 1 FROM member_proposals p JOIN workspaces w ON w.owner_principal_id=p.member_id
   WHERE p.id=NEW.proposal_id AND p.member_id=NEW.member_id AND w.id=NEW.workspace_id AND w.deleting_at IS NULL
    AND p.state='submitted' AND p.revision=NEW.revision AND p.rights_attested_revision=NEW.revision AND p.rights_attested_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Exact submitted rights required';
  END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','operation_id','attribution','audience','permission_version','published_at','withdrawn_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','operation_id','attribution','audience','permission_version','published_at','withdrawn_at']) THEN
    RAISE EXCEPTION 'Accepted revision is immutable';
  END IF;
  IF OLD.state='withdrawn' OR (OLD.state='published' AND NEW.state<>'withdrawn')
    OR (OLD.state='accepted' AND NEW.state NOT IN ('published','withdrawn')) THEN
    RAISE EXCEPTION 'Publication cannot be replayed as a new transition';
  END IF;
  IF NEW.state='withdrawn' AND (to_jsonb(NEW)-ARRAY['state','attribution','withdrawn_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attribution','withdrawn_at']) THEN
    RAISE EXCEPTION 'Withdrawal preserves only the original receipt';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proposal_publication_guard ON proposal_publications;
CREATE TRIGGER proposal_publication_guard BEFORE INSERT OR UPDATE ON proposal_publications
 FOR EACH ROW EXECUTE FUNCTION guard_proposal_publication();
CREATE OR REPLACE FUNCTION revoke_changed_proposal_publications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'submitted' OR NEW.revision<>OLD.revision OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body OR NEW.sources IS DISTINCT FROM OLD.sources
    OR NEW.rights_attested_revision IS DISTINCT FROM OLD.rights_attested_revision THEN
   UPDATE proposal_publications SET state='withdrawn',attribution=NULL,withdrawn_at=clock_timestamp()
    WHERE proposal_id=OLD.id AND state<>'withdrawn';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proposal_publication_source_change ON member_proposals;
CREATE TRIGGER proposal_publication_source_change AFTER UPDATE ON member_proposals
 FOR EACH ROW EXECUTE FUNCTION revoke_changed_proposal_publications();
INSERT INTO schema_migrations(version) VALUES(75) ON CONFLICT DO NOTHING;
COMMIT;
