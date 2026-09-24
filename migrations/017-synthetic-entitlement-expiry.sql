BEGIN;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=17) THEN
ALTER TABLE synthetic_entitlement_grants
 ADD COLUMN starts_at timestamptz,
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN expired integer NOT NULL DEFAULT 0 CHECK(expired >= 0),
 ADD COLUMN expired_at timestamptz;
ALTER TABLE synthetic_entitlement_grants
 DROP CONSTRAINT synthetic_entitlement_grants_check,
 ADD CONSTRAINT synthetic_entitlement_grants_balance_check
  CHECK(available + reserved + consumed + expired = quantity),
 ADD CONSTRAINT synthetic_entitlement_grants_window_check
  CHECK(starts_at <= expires_at);
ALTER TABLE synthetic_entitlement_events
 DROP CONSTRAINT synthetic_entitlement_events_operation_check,
 ADD CONSTRAINT synthetic_entitlement_events_operation_check
  CHECK(operation IN ('grant','reserve','consume','release','expire')),
 DROP CONSTRAINT synthetic_entitlement_events_quantity_check,
 ADD CONSTRAINT synthetic_entitlement_events_quantity_check
  CHECK(quantity >= 0 AND (operation='expire' OR quantity > 0)),
 DROP CONSTRAINT synthetic_entitlement_events_check,
 ADD CONSTRAINT synthetic_entitlement_events_check
  CHECK((operation IN ('grant','expire') AND reservation_id IS NULL) OR
        (operation IN ('reserve','consume','release') AND reservation_id IS NOT NULL));
-- Existing synthetic-only records have no approved period. Fail closed and
-- record the transition before replacing their available balance.
INSERT INTO synthetic_entitlement_events
 (id,member_id,grant_id,reservation_id,operation,quantity,
  idempotency_key,request_fingerprint,result_id)
SELECT gen_random_uuid(),member_id,id,NULL,'expire',available,
       'migration-017-expire-' || id::text,
       encode(sha256(convert_to(
         format('{"operation":"expire","memberId":"%s","grantId":"%s"}',member_id,id),
         'UTF8')),'hex'),id
FROM synthetic_entitlement_grants WHERE starts_at IS NULL;
UPDATE synthetic_entitlement_grants SET
 starts_at=created_at, expires_at=created_at, expired_at=created_at,
 expired=available, available=0 WHERE starts_at IS NULL;
ALTER TABLE synthetic_entitlement_grants
 ALTER COLUMN starts_at SET NOT NULL,
 ALTER COLUMN expires_at SET NOT NULL;
INSERT INTO schema_migrations(version) VALUES(17) ON CONFLICT DO NOTHING;
END IF;
END $$;
COMMIT;
