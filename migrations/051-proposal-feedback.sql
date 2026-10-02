BEGIN;
-- Retain only the current feedback. Historical consent is deliberately unknown.
ALTER TABLE member_proposals
 ADD COLUMN IF NOT EXISTS change_feedback text,
 ADD COLUMN IF NOT EXISTS change_feedback_revision integer,
 ADD COLUMN IF NOT EXISTS changes_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS rights_attested_revision integer;
-- Recreate named guards on rerun, including after a repaired revision column.
ALTER TABLE member_proposals
 DROP CONSTRAINT IF EXISTS member_proposals_state_check,
 DROP CONSTRAINT IF EXISTS member_proposals_check,
 DROP CONSTRAINT IF EXISTS member_proposals_feedback_check,
 DROP CONSTRAINT IF EXISTS member_proposals_rights_revision_check,
 ADD CONSTRAINT member_proposals_state_check CHECK(state IN ('draft','submitted','changes_requested','quarantined','rejected','withdrawn')),
 ADD CONSTRAINT member_proposals_check CHECK(state NOT IN ('draft','submitted','changes_requested','quarantined') OR
   (title IS NOT NULL AND length(title) BETWEEN 1 AND 160 AND
    body IS NOT NULL AND length(body) BETWEEN 1 AND 4000 AND
    sources IS NOT NULL AND length(sources) BETWEEN 1 AND 1000)),
 ADD CONSTRAINT member_proposals_feedback_check CHECK(
   (change_feedback IS NULL AND change_feedback_revision IS NULL AND changes_requested_at IS NULL AND state<>'changes_requested') OR
   (change_feedback IS NOT NULL AND change_feedback_revision IS NOT NULL AND changes_requested_at IS NOT NULL
    AND length(btrim(change_feedback))>0
    AND char_length(change_feedback)+regexp_count(change_feedback COLLATE "C", U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 1000
    AND change_feedback_revision>0 AND change_feedback_revision<=revision
    AND state IN ('changes_requested','submitted','quarantined')
    AND (state<>'changes_requested' OR (rights_attested_at IS NULL AND rights_attested_revision IS NULL AND moderated_by IS NOT NULL AND moderated_at IS NOT NULL AND submitted_at IS NOT NULL))
    AND (state='changes_requested' OR (rights_attested_revision IS NOT NULL AND rights_attested_revision=revision AND revision>change_feedback_revision)))),
 ADD CONSTRAINT member_proposals_rights_revision_check CHECK(rights_attested_revision IS NULL OR
   (rights_attested_at IS NOT NULL AND rights_attested_revision>0 AND rights_attested_revision<=revision));
ALTER TABLE proposal_audit ADD COLUMN IF NOT EXISTS reviewed_revision integer;
ALTER TABLE proposal_audit
 DROP CONSTRAINT IF EXISTS proposal_audit_action_check,
 DROP CONSTRAINT IF EXISTS proposal_audit_new_state_check,
 DROP CONSTRAINT IF EXISTS proposal_audit_check,
 DROP CONSTRAINT IF EXISTS proposal_audit_reviewed_revision_check,
 ADD CONSTRAINT proposal_audit_action_check CHECK(action IN ('proposal_read','proposal_quarantined','proposal_rejected','proposal_changes_requested')),
 ADD CONSTRAINT proposal_audit_new_state_check CHECK(new_state IN ('submitted','quarantined','rejected','changes_requested')),
 ADD CONSTRAINT proposal_audit_check CHECK((action='proposal_read' AND old_state=new_state)
   OR (action='proposal_quarantined' AND old_state='submitted' AND new_state='quarantined')
   OR (action='proposal_rejected' AND new_state='rejected')
   OR (action='proposal_changes_requested' AND old_state='submitted' AND new_state='changes_requested' AND reviewed_revision IS NOT NULL)),
 ADD CONSTRAINT proposal_audit_reviewed_revision_check CHECK(reviewed_revision IS NULL OR reviewed_revision>0);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_changes_revision_idx ON proposal_audit(proposal_id,reviewed_revision)
 WHERE action='proposal_changes_requested';
-- Existing audit immutability and actual owning-workspace cascade remain intact.
INSERT INTO schema_migrations(version) VALUES(51) ON CONFLICT DO NOTHING;
COMMIT;
