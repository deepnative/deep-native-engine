-- #832 slice B (owner, 12 November 2026): an administrator sets each
-- student's billing period (1 week, 2 weeks, 1 month or 1 to 31 days) with the
-- date the first period starts. Periods run back to back; a changed length
-- applies from the next period. Calendar-month records stay as they are.
BEGIN;
-- Each setting is a new version, append-only. `days` 7 is one week and 14 two
-- weeks; a 'month' runs to the day before the same day next month.
CREATE TABLE IF NOT EXISTS coaching_billing_schedules (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK(version>0),
 unit text NOT NULL CHECK(unit IN ('days','month')),
 days integer,
 starts_on date NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,version),
 CHECK((unit='month' AND days IS NULL) OR (unit='days' AND days IS NOT NULL AND days BETWEEN 1 AND 31))
);
DROP TRIGGER IF EXISTS coaching_billing_schedules_immutable ON coaching_billing_schedules;
CREATE TRIGGER coaching_billing_schedules_immutable BEFORE UPDATE OR DELETE ON coaching_billing_schedules
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();

-- The key column `month` now holds a period key: YYYY-MM for a calendar month
-- (every existing row) or YYYY-MM-DD, the first day of a defined period.
ALTER TABLE coaching_months ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE coaching_months ADD COLUMN IF NOT EXISTS period_end date;
UPDATE coaching_months
 SET period_start=to_date(month||'-01','YYYY-MM-DD'),
     period_end=(to_date(month||'-01','YYYY-MM-DD')+interval '1 month'-interval '1 day')::date
 WHERE period_start IS NULL OR period_end IS NULL;
ALTER TABLE coaching_months ALTER COLUMN period_start SET NOT NULL;
ALTER TABLE coaching_months ALTER COLUMN period_end SET NOT NULL;
ALTER TABLE coaching_months DROP CONSTRAINT IF EXISTS coaching_months_month_check;
ALTER TABLE coaching_months ADD CONSTRAINT coaching_months_month_check CHECK(
 (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
   AND to_char(period_start,'YYYY-MM-DD')=month||'-01'
   AND period_end=(period_start+interval '1 month'-interval '1 day')::date)
 OR (month ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND to_char(period_start,'YYYY-MM-DD')=month
   AND period_end BETWEEN period_start AND period_start+30));
ALTER TABLE coaching_months DROP CONSTRAINT IF EXISTS coaching_months_minutes_fit_period;
ALTER TABLE coaching_months ADD CONSTRAINT coaching_months_minutes_fit_period
 CHECK(minutes<=(period_end-period_start+1)*1440);
CREATE INDEX IF NOT EXISTS coaching_months_owner_period_idx ON coaching_months(owner_id,period_start);
-- One student's periods never overlap, and a saved period keeps its dates.
CREATE OR REPLACE FUNCTION guard_coaching_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- A calendar-month key saved without dates covers that month.
 IF TG_OP='INSERT' AND NEW.period_start IS NULL AND NEW.period_end IS NULL
   AND NEW.month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
  NEW.period_start := to_date(NEW.month||'-01','YYYY-MM-DD');
  NEW.period_end := (NEW.period_start+interval '1 month'-interval '1 day')::date;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.period_start,NEW.period_end,NEW.month) IS DISTINCT FROM (OLD.period_start,OLD.period_end,OLD.month)
 THEN RAISE EXCEPTION 'A saved coaching period keeps its dates'; END IF;
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM coaching_months o WHERE o.owner_id=NEW.owner_id
   AND o.month<>NEW.month AND o.period_start<=NEW.period_end AND o.period_end>=NEW.period_start)
 THEN RAISE EXCEPTION 'Coaching periods cannot overlap'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS coaching_period_guard ON coaching_months;
CREATE TRIGGER coaching_period_guard BEFORE INSERT OR UPDATE ON coaching_months
 FOR EACH ROW EXECUTE FUNCTION guard_coaching_period();

-- Invoices carry the same period key; the existing unique index keeps one
-- non-void coaching invoice per student per period.
ALTER TABLE simple_invoices DROP CONSTRAINT IF EXISTS simple_invoices_coaching_month_check;
ALTER TABLE simple_invoices ADD CONSTRAINT simple_invoices_coaching_month_check
 CHECK(coaching_month IS NULL OR coaching_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-[0-9]{2})?$');
-- A defined period is invoiced only after its last day (UTC).
CREATE OR REPLACE FUNCTION require_ended_coaching_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.coaching_month ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND NOT EXISTS(
   SELECT 1 FROM coaching_months m WHERE m.owner_id=NEW.owner_id AND m.month=NEW.coaching_month
     AND m.period_end<(clock_timestamp() AT TIME ZONE 'UTC')::date)
 THEN RAISE EXCEPTION 'A coaching period is invoiced only after it has ended'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS coaching_invoice_after_period ON simple_invoices;
CREATE TRIGGER coaching_invoice_after_period BEFORE INSERT ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION require_ended_coaching_period();

-- Staff change history: a period key or a setting's start date, and the new
-- kind of change. Migration 140 is guarded on this one.
ALTER TABLE billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_month_check;
ALTER TABLE billing_change_events ADD CONSTRAINT billing_change_events_month_check
 CHECK(month ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$');
ALTER TABLE billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_action_check;
ALTER TABLE billing_change_events ADD CONSTRAINT billing_change_events_action_check
 CHECK(action IN ('plan_offered','rate_set','hours_returned','hours_overridden','billing_period_set','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','payment_refunded','invoice_voided','test_payment_received','test_payment_failed','test_refund_recorded'));
INSERT INTO schema_migrations(version) VALUES(141) ON CONFLICT DO NOTHING;
COMMIT;
