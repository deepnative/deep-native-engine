BEGIN;
-- #122 contribution-metrics-v1. Content-free, owner-scoped facts recorded by
-- triggers in the same transaction as each existing proposal transition, so a
-- rolled-back transition records nothing. Measurement starts at the recorded
-- cutoff; earlier history is incomplete, never reconstructed or counted as zero.
CREATE TABLE IF NOT EXISTS contribution_metrics_cutoff (
 singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO contribution_metrics_cutoff(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS contribution_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 metrics_version text NOT NULL DEFAULT 'contribution-metrics-v1' CHECK(metrics_version='contribution-metrics-v1'),
 proposal_id uuid NOT NULL,
 member_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 kind text NOT NULL CHECK(kind IN ('submitted','reviewed','accepted','published','source_withdrawn','sharing_withdrawn')),
 outcome text CHECK(outcome IN ('changes_requested','rejected','accepted')),
 cause text CHECK(cause IN ('owner','source_change')),
 actor_authority text NOT NULL CHECK(actor_authority IN ('member','moderator','platform_admin','system')),
 origin text NOT NULL CHECK(origin IN ('sample','member')),
 workflow_id text,
 workflow_version integer,
 permission_version text CHECK(permission_version='member-display-v1'),
 source_table text NOT NULL CHECK(source_table IN ('member_proposals','proposal_publications')),
 source_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(proposal_id,revision,kind),
 FOREIGN KEY(proposal_id,member_id) REFERENCES member_proposals(id,member_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,member_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE,
 CHECK((kind='reviewed')=(outcome IS NOT NULL)),
 CHECK((kind='sharing_withdrawn')=(cause IS NOT NULL)),
 CHECK((kind='published')=(permission_version IS NOT NULL)),
 CHECK(kind NOT IN ('reviewed','accepted') OR actor_authority IN ('moderator','platform_admin')),
 CHECK(kind NOT IN ('submitted','published','source_withdrawn') OR actor_authority='member'),
 CHECK(kind<>'sharing_withdrawn' OR (cause='owner' AND actor_authority='member') OR (cause='source_change' AND actor_authority='system'))
);
CREATE INDEX IF NOT EXISTS contribution_events_owner_idx ON contribution_events(member_id,id);
CREATE INDEX IF NOT EXISTS contribution_events_kind_idx ON contribution_events(origin,kind);

CREATE OR REPLACE FUNCTION reject_contribution_event_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Contribution events are immutable';
END $$;
DROP TRIGGER IF EXISTS contribution_events_immutable ON contribution_events;
CREATE TRIGGER contribution_events_immutable BEFORE UPDATE ON contribution_events
 FOR EACH ROW EXECUTE FUNCTION reject_contribution_event_update();

CREATE OR REPLACE FUNCTION record_contribution_event(
 p_proposal uuid, p_member uuid, p_revision integer, p_kind text, p_outcome text,
 p_cause text, p_actor text, p_origin text, p_workflow text, p_workflow_version integer,
 p_permission text, p_source_table text, p_source uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- Replays and later decisions on the same revision keep the first fact.
 INSERT INTO contribution_events(proposal_id,member_id,workspace_id,revision,kind,outcome,cause,
   actor_authority,origin,workflow_id,workflow_version,permission_version,source_table,source_id)
 SELECT p_proposal,p_member,w.id,p_revision,p_kind,p_outcome,p_cause,p_actor,p_origin,
   p_workflow,p_workflow_version,p_permission,p_source_table,p_source
 FROM workspaces w WHERE w.owner_principal_id=p_member
 ON CONFLICT (proposal_id,revision,kind) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION record_proposal_contribution_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text;
BEGIN
 IF NEW.state='submitted' AND OLD.state IS DISTINCT FROM 'submitted' THEN
  PERFORM record_contribution_event(NEW.id,NEW.member_id,NEW.revision,'submitted',NULL,NULL,'member',
   NEW.origin,NEW.workflow_id,NEW.workflow_version,NULL,'member_proposals',NEW.id);
 ELSIF (NEW.state='changes_requested' AND OLD.state='submitted')
    OR (NEW.state='rejected' AND OLD.state IN ('submitted','quarantined')) THEN
  SELECT role INTO actor FROM staff_profiles WHERE principal_id=NEW.moderated_by;
  PERFORM record_contribution_event(OLD.id,OLD.member_id,OLD.revision,'reviewed',NEW.state,NULL,actor,
   OLD.origin,OLD.workflow_id,OLD.workflow_version,NULL,'member_proposals',OLD.id);
 ELSIF NEW.state='withdrawn' AND OLD.state<>'withdrawn' THEN
  PERFORM record_contribution_event(OLD.id,OLD.member_id,OLD.revision,'source_withdrawn',NULL,NULL,'member',
   OLD.origin,OLD.workflow_id,OLD.workflow_version,NULL,'member_proposals',OLD.id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS proposal_contribution_events ON member_proposals;
CREATE TRIGGER proposal_contribution_events AFTER UPDATE ON member_proposals
 FOR EACH ROW EXECUTE FUNCTION record_proposal_contribution_events();

CREATE OR REPLACE FUNCTION record_publication_contribution_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source member_proposals%ROWTYPE;
BEGIN
 SELECT * INTO source FROM member_proposals WHERE id=NEW.proposal_id;
 IF TG_OP='INSERT' THEN
  -- Acceptance is also the revision's first editorial decision unless one exists.
  PERFORM record_contribution_event(NEW.proposal_id,NEW.member_id,NEW.revision,'reviewed','accepted',NULL,
   NEW.accepted_role,source.origin,source.workflow_id,source.workflow_version,NULL,'proposal_publications',NEW.id);
  PERFORM record_contribution_event(NEW.proposal_id,NEW.member_id,NEW.revision,'accepted',NULL,NULL,
   NEW.accepted_role,source.origin,source.workflow_id,source.workflow_version,NULL,'proposal_publications',NEW.id);
 ELSIF OLD.state='accepted' AND NEW.state='published' THEN
  PERFORM record_contribution_event(NEW.proposal_id,NEW.member_id,NEW.revision,'published',NULL,NULL,'member',
   source.origin,source.workflow_id,source.workflow_version,NEW.permission_version,'proposal_publications',NEW.id);
 ELSIF OLD.state='published' AND NEW.state='withdrawn' THEN
  IF current_setting('dne.publication_revocation',true)='source_change' THEN
   PERFORM record_contribution_event(NEW.proposal_id,NEW.member_id,NEW.revision,'sharing_withdrawn',NULL,
    'source_change','system',source.origin,source.workflow_id,source.workflow_version,NULL,'proposal_publications',NEW.id);
  ELSE
   PERFORM record_contribution_event(NEW.proposal_id,NEW.member_id,NEW.revision,'sharing_withdrawn',NULL,
    'owner','member',source.origin,source.workflow_id,source.workflow_version,NULL,'proposal_publications',NEW.id);
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS publication_contribution_events ON proposal_publications;
CREATE TRIGGER publication_contribution_events AFTER INSERT OR UPDATE ON proposal_publications
 FOR EACH ROW EXECUTE FUNCTION record_publication_contribution_events();

-- Same revocation as migration 075; it now marks its cause for the event above.
CREATE OR REPLACE FUNCTION revoke_changed_proposal_publications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'submitted' OR NEW.revision<>OLD.revision OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body OR NEW.sources IS DISTINCT FROM OLD.sources
    OR NEW.rights_attested_revision IS DISTINCT FROM OLD.rights_attested_revision THEN
   PERFORM set_config('dne.publication_revocation','source_change',true);
   UPDATE proposal_publications SET state='withdrawn',attribution=NULL,withdrawn_at=clock_timestamp()
    WHERE proposal_id=OLD.id AND state<>'withdrawn';
   PERFORM set_config('dne.publication_revocation','',true);
 END IF;
 RETURN NEW;
END $$;
INSERT INTO schema_migrations(version) VALUES(88) ON CONFLICT DO NOTHING;
COMMIT;
