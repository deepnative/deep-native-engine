BEGIN;
-- #696 ROLE-LABEL-01: a role for an email with no account needs a label an
-- administrator can recognise. Keep a masked hint (first letters and the
-- domain, never the full address) and the grant date.
ALTER TABLE account_roles ADD COLUMN IF NOT EXISTS email_hint text
 CHECK(email_hint IS NULL OR (length(email_hint)<=260 AND email_hint LIKE '%…@%'));
ALTER TABLE account_roles ADD COLUMN IF NOT EXISTS granted_at timestamptz;
ALTER TABLE account_roles ALTER COLUMN granted_at SET DEFAULT clock_timestamp();
-- The two seeded owners' addresses are known, so they get a hint now.
UPDATE account_roles r SET email_hint=s.hint
  FROM (VALUES
   (encode(sha256(convert_to('shi@deepnative.io','UTF8')),'hex'),'sh…@deepnative.io'),
   (encode(sha256(convert_to('tom@deepnative.io','UTF8')),'hex'),'to…@deepnative.io')
  ) s(h,hint)
 WHERE r.email_hash=s.h AND r.email_hint IS NULL;
-- Roles granted on the Roles page before this have an audited grant time.
UPDATE account_roles r SET granted_at=e.at
  FROM (SELECT email_hash,role,max(occurred_at) AS at FROM account_role_events
         WHERE action='granted' GROUP BY email_hash,role) e
 WHERE r.granted_at IS NULL AND r.email_hash=e.email_hash AND r.role=e.role
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=98);
INSERT INTO schema_migrations(version) VALUES(98) ON CONFLICT DO NOTHING;
COMMIT;
