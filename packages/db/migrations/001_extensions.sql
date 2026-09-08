-- Extensions.
--
-- postgis is marked trusted on the host, so it installs without superuser.
-- pg_trgm and unaccent are trusted from PG13 onward. vector is optional: the
-- semantic layer only switches on when it is present, so a host without it
-- still runs the full deterministic search path.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable (%); semantic search stays disabled', SQLERRM;
END
$$;

-- Records which optional capabilities this database actually has, so the API
-- can branch on facts rather than on a guess about the host.
CREATE TABLE IF NOT EXISTS db_capabilities (
  name       text PRIMARY KEY,
  available  boolean NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO db_capabilities (name, available)
SELECT 'vector', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
ON CONFLICT (name) DO UPDATE
  SET available = EXCLUDED.available, checked_at = now();
