BEGIN;
-- #623 Only a submitted revision can be withdrawn as a contribution; a private
-- draft or an edited, unsubmitted revision records nothing. An owner's own
-- proposal withdrawal ends display as an owner action, not a source change.
-- Events already recorded are not rewritten.
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
 ELSIF NEW.state='withdrawn' AND (OLD.state IN ('submitted','quarantined')
    OR (OLD.state='changes_requested' AND OLD.revision=OLD.change_feedback_revision)) THEN
  PERFORM record_contribution_event(OLD.id,OLD.member_id,OLD.revision,'source_withdrawn',NULL,NULL,'member',
   OLD.origin,OLD.workflow_id,OLD.workflow_version,NULL,'member_proposals',OLD.id);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION revoke_changed_proposal_publications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'submitted' OR NEW.revision<>OLD.revision OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body OR NEW.sources IS DISTINCT FROM OLD.sources
    OR NEW.rights_attested_revision IS DISTINCT FROM OLD.rights_attested_revision THEN
   IF NEW.state<>'withdrawn' THEN
    PERFORM set_config('dne.publication_revocation','source_change',true);
   END IF;
   UPDATE proposal_publications SET state='withdrawn',attribution=NULL,withdrawn_at=clock_timestamp()
    WHERE proposal_id=OLD.id AND state<>'withdrawn';
   PERFORM set_config('dne.publication_revocation','',true);
 END IF;
 RETURN NEW;
END $$;
INSERT INTO schema_migrations(version) VALUES(92) ON CONFLICT DO NOTHING;
COMMIT;
