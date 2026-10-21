BEGIN;
CREATE TABLE IF NOT EXISTS private_object_write_intents (
  storage_key UUID PRIMARY KEY
);
INSERT INTO schema_migrations(version) VALUES(72) ON CONFLICT DO NOTHING;
COMMIT;
