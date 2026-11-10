BEGIN;
-- #196 RPTD-01..09: a currently granted circle moderator records what happened
-- to one member report. A report with no row here is open at revision 1. Each
-- row is one transition at the next revision, at most two per report:
-- open -> escalated (a local second look; no assignee or promise),
-- open|escalated -> rejected (this report is not actionable), or
-- open|escalated -> closed (an authorized actor inspected the exact recorded
-- hide/restore decision at that post revision). A report disposition never
-- changes a post, another report or a grant. Rows carry no text, and leave with
-- the report when the reporter's account is erased.
CREATE TABLE IF NOT EXISTS preview_circle_report_dispositions (
 report_id uuid NOT NULL REFERENCES preview_circle_reports(id) ON DELETE CASCADE,
 circle_id text NOT NULL,
 revision integer NOT NULL CHECK(revision IN (2,3)),
 action text NOT NULL CHECK(action IN ('escalated','rejected','closed')),
 reason text NOT NULL,
 actor_id uuid NOT NULL,
 actor_role text NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>=1),
 decision_revision integer,
 idempotency_key uuid NOT NULL,
 fingerprint text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(report_id,revision),
 UNIQUE(actor_id,idempotency_key),
 CHECK((action='escalated' AND reason IN ('needs_another_look','policy_unclear'))
    OR (action='rejected' AND reason IN ('rule_not_breached','insufficient_context'))
    OR (action='closed' AND reason='recorded_target_decision')),
 CHECK((action='closed')=(decision_revision IS NOT NULL)),
 CHECK(revision=2 OR action<>'escalated')
);
CREATE OR REPLACE FUNCTION guard_preview_circle_report_disposition() RETURNS trigger AS $$
DECLARE previous text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM preview_circle_reports WHERE id=OLD.report_id) THEN
   RAISE EXCEPTION 'Circle report dispositions are immutable';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'Circle report dispositions are immutable';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM preview_circle_reports WHERE id=NEW.report_id AND circle_id=NEW.circle_id) THEN
  RAISE EXCEPTION 'Circle report disposition requires its exact report';
 END IF;
 IF NEW.revision=3 THEN
  SELECT action INTO previous FROM preview_circle_report_dispositions WHERE report_id=NEW.report_id AND revision=2;
  IF previous IS DISTINCT FROM 'escalated' THEN
   RAISE EXCEPTION 'Circle report disposition transition is invalid';
  END IF;
 END IF;
 IF NEW.action='closed' AND NOT EXISTS(
   SELECT 1 FROM preview_circle_reports r JOIN preview_circle_moderation_audit a
     ON a.circle_id=r.circle_id AND a.post_id=r.target_id
   WHERE r.id=NEW.report_id AND a.new_revision=NEW.decision_revision AND a.occurred_at>=r.created_at) THEN
  RAISE EXCEPTION 'Circle report closure requires a recorded decision after the report';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS preview_circle_report_disposition_guard ON preview_circle_report_dispositions;
CREATE TRIGGER preview_circle_report_disposition_guard BEFORE INSERT OR UPDATE OR DELETE ON preview_circle_report_dispositions
 FOR EACH ROW EXECUTE FUNCTION guard_preview_circle_report_disposition();
INSERT INTO schema_migrations(version) VALUES(134) ON CONFLICT DO NOTHING;
COMMIT;
