-- The same questions, every time.
--
-- Whether a change to search made it better is not something one query can
-- show. A benchmark is a fixed list of queries, each with the answer someone
-- decided is right, put to every search interface the site has — the quick
-- search box, the smart search and the free-language question — with what came
-- back kept in order, so two runs can be compared row by row.
--
-- A run is the list and its settings. A cell is one query through one
-- interface: the results as they were ranked at that moment, with the names
-- copied in, because the cards table is rebuilt and a benchmark that can only
-- be read against today's corpus cannot say what last month's looked like.
--
-- Cells are written one at a time and keyed by (run, query, mode), so a run
-- interrupted by a restart picks up where it stopped instead of starting over.

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  lang        text NOT NULL DEFAULT 'he',
  modes       text[] NOT NULL,
  -- [{ "query": "...", "expected": ["card_id", ...] }], in the order given.
  queries     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  total       int NOT NULL,
  error       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS benchmark_runs_recent_idx ON benchmark_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_cells (
  run_id      uuid NOT NULL REFERENCES benchmark_runs (id) ON DELETE CASCADE,
  query_no    int NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('quick', 'smart', 'free')),
  -- [{ card_id, service_name, organization_name, branch_name, city }], ranked.
  hits        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many the interface said it had, which for quick search can exceed
  -- the page that was kept.
  total       int,
  answer      text,
  duration_ms int,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, query_no, mode)
);
