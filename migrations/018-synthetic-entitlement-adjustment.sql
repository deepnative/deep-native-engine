BEGIN;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=18) THEN
ALTER TABLE synthetic_entitlement_grants
 ADD COLUMN adjusted integer NOT NULL DEFAULT 0 CHECK(adjusted >= 0),
 DROP CONSTRAINT synthetic_entitlement_grants_balance_check,
 ADD CONSTRAINT synthetic_entitlement_grants_balance_check
  CHECK(available + reserved + consumed + expired + adjusted = quantity);
ALTER TABLE synthetic_entitlement_events
 DROP CONSTRAINT synthetic_entitlement_events_operation_check,
 ADD CONSTRAINT synthetic_entitlement_events_operation_check
  CHECK(operation IN ('grant','reserve','consume','release','expire','adjust')),
 DROP CONSTRAINT synthetic_entitlement_events_check,
 ADD CONSTRAINT synthetic_entitlement_events_check
  CHECK((operation IN ('grant','expire','adjust') AND reservation_id IS NULL) OR
        (operation IN ('reserve','consume','release') AND reservation_id IS NOT NULL));
INSERT INTO schema_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;
END IF;
END $$;
COMMIT;
