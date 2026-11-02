BEGIN;
ALTER TABLE learners ADD COLUMN IF NOT EXISTS display_name text
 CHECK (display_name IS NULL OR (length(display_name) BETWEEN 1 AND 80
   AND display_name=btrim(display_name) AND display_name !~ '[[:cntrl:]]'));
INSERT INTO schema_migrations(version) VALUES(87) ON CONFLICT DO NOTHING;
COMMIT;
