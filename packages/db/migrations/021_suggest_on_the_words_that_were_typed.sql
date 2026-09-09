-- Suggestions were matched against the whole sentence, so a sentence never
-- matched.
--
-- Both places that turn words into categories — the search box's autocomplete
-- and the find_taxonomy tool the smart search and MCP clients use — asked the
-- same two questions of every node:
--
--     search_text % ssil_normalize(q)                        -- whole-string trigram
--     search_text ILIKE '%' || ssil_normalize(q) || '%'      -- whole-string substring
--
-- Both are whole-phrase tests, and both fail as soon as somebody types more
-- than a category name. similarity() compares two complete strings, so its
-- score falls away as the query grows past the node's own name. And
-- ssil_normalize interleaves each word with its de-prefixed variant — "עזרה
-- במילוי טפסים" becomes "עזרה עזר במילוי מילוי טפסים" — which is a string no
-- node text can contain, so the ILIKE could not match a multi-word query at
-- all. The failure was silent in the worst way: nothing was suggested, so the
-- person was told nothing and simply searched for the literal sentence.
--
--     טיפול נפשי            3 suggestions
--     טיפול נפשי לבת 13     0
--     עזרה במילוי טפסים     0
--
-- A suggestion list should answer "which categories do any of these words point
-- at", so that is what this asks. Each typed word is matched on its own, as
-- written and with a leading particle removed — the same pair the index is
-- built from, which is what lets "במילוי" reach "מילוי". A node scores by how
-- many of the words it accounts for, how well it matches them, and how many
-- services sit under it, in that order of weight: a category nothing is tagged
-- with is a dead end, and offering it wastes the one attempt somebody in
-- distress is likely to make.
CREATE OR REPLACE FUNCTION ssil_suggest_taxonomy(
  input     text,
  in_lang   text      DEFAULT 'he',
  in_axis   ssil_axis DEFAULT NULL,
  used_only boolean   DEFAULT true,
  lim       int       DEFAULT 10
) RETURNS TABLE (id text, axis ssil_axis, name text, card_count int, matched int)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  -- Materialised: the view normalises every node name and synonym list on
  -- every scan, and it must be paid for once rather than once per typed word.
  WITH nodes AS MATERIALIZED (
    SELECT s.id, s.axis, s.name, s.card_count, s.search_text
    FROM taxonomy_suggestions s
    WHERE s.lang = in_lang
      AND (in_axis IS NULL OR s.axis = in_axis)
      AND (NOT used_only OR s.card_count > 0)
  ),
  -- ssil_normalize_plain, not ssil_normalize: one form per word, in the order
  -- they were typed. A bare number is an age rather than a word — see 020.
  typed AS (
    SELECT ord, tok
    FROM unnest(string_to_array(ssil_normalize_plain(input), ' ')) WITH ORDINALITY AS u(tok, ord)
    WHERE length(tok) > 1 AND tok !~ '^[0-9]+$'
  ),
  terms AS (
    SELECT DISTINCT t.ord, v.form
    FROM typed t
    CROSS JOIN LATERAL (VALUES (t.tok), (ssil_strip_prefix(t.tok))) AS v(form)
    WHERE length(v.form) > 1
  ),
  -- One row per (node, typed word) the node accounts for. The regex is safe
  -- built this way: ssil_tokens has already reduced the input to letters and
  -- digits, so there is nothing left that could be read as a metacharacter.
  hits AS (
    SELECT n.id, n.axis, n.name, n.card_count, t.ord,
           max(CASE
                 -- A word of the node's text starts with what was typed. This
                 -- is also what makes a half-typed word suggest anything.
                 WHEN n.search_text ~ ('(^| )' || t.form) THEN 1.0
                 ELSE word_similarity(t.form, n.search_text)
               END)::float8 AS sim
    FROM nodes n
    JOIN terms t
      ON n.search_text ~ ('(^| )' || t.form)
      OR word_similarity(t.form, n.search_text) >= 0.6
    GROUP BY n.id, n.axis, n.name, n.card_count, t.ord
  )
  SELECT h.id, h.axis, h.name, h.card_count, count(*)::int
  FROM hits h
  GROUP BY h.id, h.axis, h.name, h.card_count
  ORDER BY count(*) * 1.5 + max(h.sim) * 2 + ln(1 + h.card_count) * 0.5 DESC,
           h.card_count DESC
  LIMIT lim;
$$;

DO $$
DECLARE
  n int;
BEGIN
  -- Nonsense suggests nothing, on an empty database as much as a full one. The
  -- old query returned the largest categories in the corpus for any input it
  -- could not normalise, which is how a typo became a page of childcare.
  SELECT count(*) INTO n FROM ssil_suggest_taxonomy('קשקושבלבלה');
  IF n <> 0 THEN
    RAISE EXCEPTION 'nonsense suggests % categories', n;
  END IF;

  -- The rest needs a corpus to suggest from. A fresh channel migrates before
  -- anything is imported, and an assertion that cannot hold there would turn
  -- the first deploy of an empty database into a rollback.
  IF NOT EXISTS (SELECT 1 FROM taxonomy_card_counts WHERE card_count > 0) THEN
    RETURN;
  END IF;

  -- The sentence that returned nothing must now reach the categories its words
  -- point at, and the single word it was built from must still work.
  SELECT count(*) INTO n FROM ssil_suggest_taxonomy('טיפול נפשי לבת 13');
  IF n = 0 THEN
    RAISE EXCEPTION 'a sentence still suggests nothing';
  END IF;

  SELECT count(*) INTO n FROM ssil_suggest_taxonomy('מזון');
  IF n = 0 THEN
    RAISE EXCEPTION 'a plain word stopped suggesting anything';
  END IF;

  -- A word carrying a particle reaches the same node as the word itself.
  SELECT count(*) INTO n FROM ssil_suggest_taxonomy('למזון');
  IF n = 0 THEN
    RAISE EXCEPTION 'a prefixed word suggests nothing';
  END IF;
END
$$;
