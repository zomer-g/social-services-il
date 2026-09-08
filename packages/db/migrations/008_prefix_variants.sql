-- Hebrew prefixes, done symmetrically.
--
-- The first attempt stripped a leading particle and indexed only the result.
-- That cannot work, because stripping is not idempotent and a word may or may
-- not begin with a letter that is also a particle:
--
--   מזון  → strips its מ  → זון      (the מ is part of the root, but we cannot tell)
--   למזון → strips its ל  → מזון
--
-- The document and the query therefore land on different tokens and never meet.
-- Searching "למזון" found nothing that searching "מזון" found.
--
-- The fix is to stop choosing. Every token is indexed both as written and with
-- one particle removed, and every query term matches either form. The pair
-- always intersects whichever way the word was written:
--
--   document מזון  → {מזון, זון}
--   query    למזון → (למזון | מזון)   → meets on מזון
--   query    מזון  → (מזון | זון)     → meets on מזון
--
-- The cost is roughly twice as many index entries and some loss of precision
-- where a stripped form collides with a real word. For a corpus this size that
-- is a good trade: a missed result is invisible to the person searching, while
-- an extra one is merely ranked below the exact match.

CREATE OR REPLACE FUNCTION ssil_normalize(input text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(string_agg(form, ' '), '')
  FROM (
    SELECT DISTINCT unnest(ARRAY[folded, ssil_strip_prefix(folded)]) AS form
    FROM (
      SELECT ssil_fold_finals(t) AS folded
      FROM unnest(ssil_tokens(input)) AS t
      WHERE t NOT IN (SELECT term FROM search_stopwords)
    ) f
    WHERE length(folded) > 1
  ) v
  WHERE length(form) > 1;
$$;

-- The query side of the same rule: each term matches either form, all terms
-- required, and the last one prefix-matched so results appear while typing.
CREATE OR REPLACE FUNCTION ssil_tsquery(input text, prefix boolean DEFAULT true)
  RETURNS tsquery LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  toks   text[];
  groups text[] := '{}';
  tok    text;
  stem   text;
  star   text;
  i      int;
BEGIN
  SELECT array_agg(ssil_fold_finals(t))
    INTO toks
    FROM unnest(ssil_tokens(input)) AS t
   WHERE t NOT IN (SELECT term FROM search_stopwords)
     AND length(ssil_fold_finals(t)) > 1;

  IF toks IS NULL OR cardinality(toks) = 0 THEN
    RETURN NULL;
  END IF;

  FOR i IN 1 .. cardinality(toks) LOOP
    tok  := toks[i];
    stem := ssil_strip_prefix(tok);
    star := CASE WHEN prefix AND i = cardinality(toks) THEN ':*' ELSE '' END;

    IF stem = tok OR length(stem) < 2 THEN
      groups := groups || (tok || star);
    ELSE
      groups := groups || ('(' || tok || star || ' | ' || stem || star || ')');
    END IF;
  END LOOP;

  RETURN to_tsquery('simple', array_to_string(groups, ' & '));
END;
$$;


-- Assert the property the whole scheme exists to provide: a word and the same
-- word carrying a particle must produce overlapping token sets.
DO $$
DECLARE
  plain    text := ssil_normalize('מזון');
  prefixed text := ssil_normalize('למזון');
BEGIN
  IF NOT (string_to_array(plain, ' ') && string_to_array(prefixed, ' ')) THEN
    RAISE EXCEPTION 'prefix variants do not meet: "%" vs "%"', plain, prefixed;
  END IF;

  IF ssil_tsquery('למזון', false) IS NULL THEN
    RAISE EXCEPTION 'ssil_tsquery returned nothing for a real word';
  END IF;

  -- A document written plainly must satisfy a query written with a particle.
  IF NOT (to_tsvector('simple', ssil_normalize('חלוקת מזון')) @@ ssil_tsquery('למזון', false)) THEN
    RAISE EXCEPTION 'a prefixed query does not match a plain document';
  END IF;

  -- And the reverse.
  IF NOT (to_tsvector('simple', ssil_normalize('סיוע למזון')) @@ ssil_tsquery('מזון', false)) THEN
    RAISE EXCEPTION 'a plain query does not match a prefixed document';
  END IF;

  -- Stopwords still disappear, and nonsense still matches nothing.
  IF ssil_tsquery('שירות', false) IS NOT NULL THEN
    RAISE EXCEPTION 'a stopword-only query should produce no tsquery';
  END IF;
END
$$;


-- Every card's search_doc and search_text were built by the previous
-- normalisation and are now stale.
--
-- The rebuild is not run here. Migrations execute before the server opens its
-- socket, and the platform gives a container 120 seconds to answer its health
-- check; a rebuild over a full corpus can outlast that and would turn a routine
-- deploy into a rollback. Instead a flag is raised, and the server rebuilds
-- after it is already serving.
CREATE TABLE IF NOT EXISTS system_state (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_state (key, value) VALUES ('cards_need_rebuild', 'normalisation changed')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
