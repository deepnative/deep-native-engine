BEGIN;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=46) THEN
 ALTER TABLE synthetic_slot_holds ADD COLUMN released_at timestamptz;
 ALTER TABLE synthetic_slot_holds
   DROP CONSTRAINT synthetic_slot_holds_state_check,
   ADD CONSTRAINT synthetic_slot_holds_state_check CHECK(state IN ('held','expired','released')),
   DROP CONSTRAINT synthetic_slot_holds_check,
   ADD CONSTRAINT synthetic_slot_holds_check CHECK(
     (state='held' AND expired_at IS NULL AND released_at IS NULL) OR
     (state='expired' AND expired_at IS NOT NULL AND released_at IS NULL) OR
     (state='released' AND expired_at IS NULL AND released_at IS NOT NULL));
 INSERT INTO schema_migrations(version) VALUES(46);
END IF;
END $$;

CREATE OR REPLACE FUNCTION withdraw_member_sample_hold(p_token text,p_request uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_receipt record;
 v_hold record;
 v_now timestamptz;
 v_key text;
 v_expiry_key text;
BEGIN
 SELECT r.member_id,r.hold_id,r.slot_id INTO v_receipt
 FROM synthetic_member_hold_receipts r JOIN principals p ON p.id=r.member_id
 WHERE r.request_id=p_request AND p.token_hash=p_token AND p.kind='member'
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp();
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample withdrawal unavailable';
 END IF;
 -- Share expiry's advisory lock, then its slot and settlement row lock order.
 -- No member lock is retained while waiting for the slot.
 v_expiry_key := 'sample-expire:' || v_receipt.hold_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_expiry_key,0));
 PERFORM 1 FROM expert_availability_slots WHERE id=v_receipt.slot_id FOR UPDATE;
 SELECT h.*,r.state AS reservation_state,r.quantity AS reservation_quantity,
        g.category,g.expires_at AS grant_expires_at,g.expired_at AS grant_expired_at,
        member.token_hash,member.kind,member.revoked_at,member.expires_at AS member_expires_at
 INTO v_hold
 FROM synthetic_slot_holds h
 JOIN synthetic_entitlement_reservations r ON r.id=h.reservation_id AND r.grant_id=h.grant_id
 JOIN synthetic_entitlement_grants g ON g.id=h.grant_id AND g.member_id=h.member_id
 JOIN principals member ON member.id=h.member_id
 JOIN synthetic_member_hold_receipts receipt ON receipt.hold_id=h.id
   AND receipt.member_id=h.member_id AND receipt.slot_id=h.slot_id AND receipt.grant_id=h.grant_id
 WHERE h.id=v_receipt.hold_id AND h.member_id=v_receipt.member_id
   AND g.category=CASE receipt.service_type WHEN 'coaching' THEN 'coach_minutes' ELSE 'review_minutes' END
 FOR UPDATE OF h,r,g,member;
 -- Read wall time and validate the token again after all potentially blocking locks.
 v_now := clock_timestamp();
 IF NOT FOUND OR v_hold.token_hash<>p_token OR v_hold.kind<>'member'
   OR v_hold.revoked_at IS NOT NULL OR v_hold.member_expires_at<=v_now THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample withdrawal unavailable';
 END IF;
 IF v_hold.state IN ('released','expired') THEN RETURN p_request; END IF;
 IF v_hold.reservation_state<>'reserved' OR v_hold.reservation_quantity<>60 THEN
   RAISE EXCEPTION USING ERRCODE='DN002', MESSAGE='Sample withdrawal unavailable';
 END IF;
 IF v_hold.expires_at<=v_now THEN
   -- Deadline expiry wins. Report the actual expired receipt, never withdrawal success.
   PERFORM synthetic_expire_slot_hold(v_hold.id,v_expiry_key,
     encode(sha256(v_expiry_key::bytea),'hex'),v_now);
   RETURN p_request;
 END IF;
 IF v_hold.grant_expired_at IS NULL AND v_hold.grant_expires_at>v_now THEN
   UPDATE synthetic_entitlement_grants SET reserved=reserved-60,available=available+60
   WHERE id=v_hold.grant_id;
 ELSE
   UPDATE synthetic_entitlement_grants SET reserved=reserved-60,expired=expired+60
   WHERE id=v_hold.grant_id;
 END IF;
 UPDATE synthetic_entitlement_reservations SET state='released' WHERE id=v_hold.reservation_id;
 UPDATE synthetic_slot_holds SET state='released',released_at=v_now WHERE id=v_hold.id;
 v_key := 'sample-withdraw:' || v_hold.id;
 INSERT INTO synthetic_entitlement_events
   (id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
 VALUES(gen_random_uuid(),v_hold.member_id,v_hold.grant_id,v_hold.reservation_id,
        'release',60,v_key,encode(sha256(v_key::bytea),'hex'),v_hold.id);
 RETURN p_request;
END $$;
COMMIT;
