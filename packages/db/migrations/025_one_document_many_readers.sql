-- One document, many readers.
--
-- Choosing which model reads ten thousand agreements is a decision about money
-- and about accuracy, and neither can be judged from one document or from
-- memory. So every read is kept: which model, what it answered, what it cost,
-- how long it took, and how it failed when it did.
--
-- A batch is one document sent to several models at once. Its runs share a
-- batch_id, which is what lets the screen put their answers side by side and
-- what lets the totals say, across every document tried so far, how often each
-- model agreed with the others and what it cost per document.
--
-- The document itself is not stored. It lives in memory for as long as its
-- runs are reading it; what is kept is what was learned from it, plus a hash,
-- so the same file sent twice can be recognised as the same file.

CREATE TABLE IF NOT EXISTS agreement_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL,
  filename       text NOT NULL,
  document_hash  text NOT NULL,
  document_bytes int NOT NULL,
  document_kind  text NOT NULL CHECK (document_kind IN ('pdf', 'text')),
  provider       text NOT NULL,
  model          text NOT NULL,
  -- The model the provider says answered, which can be a dated version.
  served_model   text,
  effort         text,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts       int NOT NULL DEFAULT 0,
  usage          jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost           jsonb NOT NULL DEFAULT '{}'::jsonb,
  elapsed_ms     int,
  extraction     jsonb,
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  matches        jsonb,
  -- { kind, message, problems?, answer? } — a failed run keeps what it spent.
  error          jsonb,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

CREATE INDEX IF NOT EXISTS agreement_runs_batch_idx ON agreement_runs (batch_id);
CREATE INDEX IF NOT EXISTS agreement_runs_recent_idx ON agreement_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS agreement_runs_model_idx ON agreement_runs (model, status);
