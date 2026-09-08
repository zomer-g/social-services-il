-- Sources, ingestion runs and the audit trail.
--
-- The design rule here: nothing that arrives from outside is ever written
-- straight onto an entity. It lands in `raw_records` unchanged, an ingest run
-- maps it forward, and every resulting write is recorded in `change_log`. That
-- is what makes "where did this phone number come from, and who changed it"
-- answerable, which matters because the answer is sometimes "a scraper, two
-- years ago, and it has been wrong ever since".

CREATE TYPE ssil_source_kind AS ENUM (
  'http_json',
  'csv_upload',
  'google_sheet',
  'ckan',
  'guidestar',
  'over',
  'webhook',
  'manual'
);

CREATE TABLE sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  kind        ssil_source_kind NOT NULL,
  -- Connector-specific: endpoint, credentials reference, field mapping.
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Cron expression. NULL means the source is only ever pushed to.
  schedule    text,
  -- 0-100. Above the auto-publish threshold a source writes straight to
  -- `published`; below it, everything it sends waits in the moderation queue.
  -- A ministry's own feed and a form on the internet are not the same claim.
  trust_level int NOT NULL DEFAULT 50 CHECK (trust_level BETWEEN 0 AND 100),
  enabled     boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organizations ADD CONSTRAINT organizations_source_fk
  FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE SET NULL;
ALTER TABLE branches ADD CONSTRAINT branches_source_fk
  FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE SET NULL;
ALTER TABLE services ADD CONSTRAINT services_source_fk
  FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE SET NULL;


CREATE TABLE ingest_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  -- 'scheduled', 'manual', 'push', 'dry_run'.
  trigger     text NOT NULL DEFAULT 'scheduled',
  status      text NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Counts of fetched / created / updated / unchanged / rejected records.
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text
);

CREATE INDEX ingest_runs_source_idx ON ingest_runs (source_id, started_at DESC);


CREATE TABLE raw_records (
  id            bigserial PRIMARY KEY,
  source_id     uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  ingest_run_id uuid REFERENCES ingest_runs (id) ON DELETE SET NULL,
  entity_type   text NOT NULL,
  -- The id this record carries in the source system. Together with the source
  -- it is the identity that makes re-ingestion idempotent.
  external_id   text NOT NULL,
  payload       jsonb NOT NULL,
  -- Fingerprint of the payload, so an unchanged upstream row costs nothing.
  content_hash  text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raw_records_lookup_idx
  ON raw_records (source_id, entity_type, external_id, fetched_at DESC);
CREATE INDEX raw_records_hash_idx ON raw_records (source_id, content_hash);


-- Field-level human overrides.
--
-- The generalisation of the `*_manual` columns the upstream pipeline carries.
-- An editor fixes a name or a set of tags; the next run from the source writes
-- the source value as usual, and this table is layered over it at publish time.
-- Correction and re-import stop fighting each other.
CREATE TABLE field_overrides (
  entity_type text NOT NULL CHECK (entity_type IN ('service', 'branch', 'organization', 'location')),
  entity_id   text NOT NULL,
  field       text NOT NULL,
  value       jsonb NOT NULL,
  actor       text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, field)
);


CREATE TABLE change_log (
  id          bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  action      text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'publish', 'archive')),
  -- Only the fields that changed, so the log stays readable and small.
  changed     jsonb NOT NULL DEFAULT '{}'::jsonb,
  before      jsonb,
  actor       text NOT NULL,
  source_id   uuid REFERENCES sources (id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX change_log_entity_idx ON change_log (entity_type, entity_id, at DESC);
CREATE INDEX change_log_at_idx ON change_log (at DESC);


-- Everything waiting on a human: public "this is wrong" reports, submissions
-- from organizations, and pushes from sources below the trust threshold.
CREATE TABLE moderation_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('new_service', 'update_service', 'error_report', 'new_organization')),
  entity_type text,
  entity_id   text,
  payload     jsonb NOT NULL,
  -- Free-text contact left by whoever submitted it, so an editor can follow up.
  submitted_by text,
  source_id   uuid REFERENCES sources (id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'rejected', 'merged')),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_queue_pending_idx ON moderation_queue (status, created_at DESC);
