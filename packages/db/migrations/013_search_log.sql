-- What each search actually produced, not only how many rows it returned.
--
-- The gaps view answers "what is missing from the corpus" and answers it well,
-- but it can only see searches that reached the database and came back with
-- zero rows. The failures that matter most are invisible to it: a smart search
-- that threw, one the model declined, one that hit the rate limit, one that ran
-- against a source that was down, and every deep search ever run — that route
-- recorded nothing at all. From the admin all of those looked identical to a
-- search that was never made.
--
-- So the event row now carries the outcome and the output: which route ran,
-- how it ended, which cards came back, what the model answered and which tools
-- it used to get there. That is enough to open one failed search and see the
-- stage it died at, rather than inferring it from a count of zero.
--
-- What is still deliberately absent is the searcher. No user id, no session, no
-- coordinates — has_location stays a boolean. The row says what was asked and
-- what came back, and nothing that ties either to a person.

ALTER TABLE search_events
  -- Which route ran. 'plain' is the ordinary search box, 'smart' the one that
  -- reads a sentence, 'deep' the one that fans out across MCP servers.
  ADD COLUMN kind text NOT NULL DEFAULT 'plain'
      CHECK (kind IN ('plain', 'smart', 'deep')),

  -- How it ended, from the searcher's point of view. 'empty' is a working
  -- search over a corpus that had nothing; the rest are the search itself
  -- failing, which is a different problem with a different owner.
  ADD COLUMN outcome text NOT NULL DEFAULT 'ok'
      CHECK (outcome IN ('ok', 'empty', 'error', 'declined', 'rate_limited', 'unavailable', 'invalid')),

  -- The output. Ids rather than a snapshot of the cards: the card table is the
  -- record, and a copy here would rot into a second, wrong one.
  ADD COLUMN card_ids text[] NOT NULL DEFAULT '{}',

  -- What the model said back, for the two routes that answer in prose. Kept
  -- because a plausible-sounding answer over zero cards is a failure the result
  -- count cannot express.
  ADD COLUMN answer text,
  ADD COLUMN tools_used text[] NOT NULL DEFAULT '{}',

  -- Deep search only: which servers answered, and which could not be reached.
  -- An answer assembled from two sources when three were asked is a different
  -- answer, and the admin should be able to see which one it was.
  ADD COLUMN sources text[] NOT NULL DEFAULT '{}',
  ADD COLUMN unavailable jsonb,

  -- The failure itself, in the words the server used.
  ADD COLUMN error text,
  ADD COLUMN duration_ms int;

-- The listing is "most recent first", optionally narrowed to the failures.
CREATE INDEX search_events_recent_idx ON search_events (at DESC);
CREATE INDEX search_events_failed_idx ON search_events (at DESC)
  WHERE outcome <> 'ok';
CREATE INDEX search_events_kind_idx ON search_events (kind, at DESC);

-- Existing rows predate the column and were all plain searches; the count is
-- the only outcome signal they carry, so that is what they get.
UPDATE search_events SET outcome = 'empty' WHERE result_count = 0;


-- Retention.
--
-- The row now holds the sentence somebody typed about their situation and the
-- answer they were given. That is worth keeping long enough to fix the corpus
-- and not one day longer, so it is swept on the same principle as saved lists:
-- the aggregate signal survives, the individual search does not.
--
-- Failures are kept longer than successes because they are the ones somebody
-- still has to act on, and a fortnight is not enough to notice a slow leak.
CREATE OR REPLACE FUNCTION prune_search_events() RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  removed int;
BEGIN
  DELETE FROM search_events
   WHERE (outcome = 'ok'  AND at < now() - interval '90 days')
      OR (outcome <> 'ok' AND at < now() - interval '180 days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
