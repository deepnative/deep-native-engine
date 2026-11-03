BEGIN;
-- #628 One-time owner request (3 Nov 2026): existing hosted accounts were
-- created for testing, so give each unnamed one an invented "(test)" name and
-- a sample hourly coaching rate of CAD 30-50. Runs once, before version 90 is
-- recorded; accounts created later are never touched. The owner's own
-- verified account (tom@deepnative.io) is excluded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version=90) THEN
    RETURN;
  END IF;
  WITH names(n, name) AS (
    SELECT ordinality, value FROM unnest(ARRAY[
      'Maya Chen','Liam Patel','Sofia Rossi','Noah Kim','Ava Martin',
      'Ethan Brown','Zoe Tremblay','Lucas Nguyen','Chloe Singh','Owen Roy',
      'Ella Garcia','Jack Wilson','Mia Lopez','Leo Dubois','Nora Ahmed',
      'Ryan Gagnon','Isla Murphy','Adam Cohen','Lily Park','Theo Walsh'
    ]) WITH ORDINALITY AS t(value, ordinality)
  ), unnamed AS (
    SELECT l.id, row_number() OVER (ORDER BY p.created_at, l.id) AS n
    FROM learners l JOIN principals p ON p.id=l.id AND p.kind='member'
    WHERE l.display_name IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM member_email_identities i
        WHERE i.principal_id=l.id
          AND i.email_hash=encode(sha256(convert_to('tom@deepnative.io','UTF8')),'hex'))
  )
  UPDATE learners l
  SET display_name = names.name
      || CASE WHEN u.n > 20 THEN ' ' || ((u.n - 1) / 20 + 1)::text ELSE '' END
      || ' (test)'
  FROM unnamed u JOIN names ON names.n = (u.n - 1) % 20 + 1
  WHERE l.id = u.id;
  -- Whole-dollar sample rates from CAD 30 to 50, stable per account.
  INSERT INTO coaching_rates(id, owner_id, effective_month, cents, version)
  SELECT gen_random_uuid(), l.id, to_char(CURRENT_DATE - INTERVAL '1 month', 'YYYY-MM'),
         3000 + (abs(hashtext(l.id::text)) % 21) * 100, 1
  FROM learners l JOIN principals p ON p.id=l.id AND p.kind='member'
  WHERE l.display_name LIKE '% (test)'
    AND NOT EXISTS (SELECT 1 FROM coaching_rates r WHERE r.owner_id=l.id);
END $$;
INSERT INTO schema_migrations(version) VALUES(90) ON CONFLICT DO NOTHING;
COMMIT;
