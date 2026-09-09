-- "טיפול נפשי לבת 13" — therapy for a 13-year-old girl — returned nothing.
--
-- Every token in a query is a requirement, and one of the tokens here is the
-- number 13. No service record contains it, so the whole query could only ever
-- return zero, however good the rest of it was:
--
--     טיפול נפשי            277 results   ("טיפול" is a stopword; "נפשי" carries it)
--     טיפול נפשי לבת 13       0
--
-- A bare number in this corpus is almost always an age — "בת 13", "בן 8",
-- "גיל 70" — and an age is a fact about the person, not a word that appears in
-- the record describing the service. Requiring it guarantees the one thing a
-- search must not do.
--
-- So a run of digits stops being a term, unless digits are all that was typed:
-- somebody pasting a phone number or looking for "מועדון 13" by name still
-- means it literally, and there is nothing else in the query to search on.
--
-- The index side is untouched. A number written in a service's own name stays
-- indexed and stays findable; it is only the demand that a number appear that
-- goes away.
CREATE OR REPLACE FUNCTION ssil_tsquery_build(input text, prefix boolean, combine text)
  RETURNS tsquery LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  toks   text[];
  words  text[];
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

  SELECT array_agg(t) INTO words FROM unnest(toks) AS t WHERE t !~ '^[0-9]+$';
  IF words IS NOT NULL AND cardinality(words) > 0 THEN
    toks := words;
  END IF;

  FOR i IN 1 .. cardinality(toks) LOOP
    tok  := toks[i];
    stem := ssil_strip_prefix(tok);
    -- Only the last token gets the prefix star, so that someone still typing
    -- matches; an earlier token is a word they finished.
    star := CASE WHEN prefix AND i = cardinality(toks) THEN ':*' ELSE '' END;

    IF stem = tok OR length(stem) < 2 THEN
      groups := groups || (tok || star);
    ELSE
      groups := groups || ('(' || tok || star || ' | ' || stem || star || ')');
    END IF;
  END LOOP;

  RETURN to_tsquery('simple', array_to_string(groups, combine));
END;
$$;

DO $$
DECLARE
  aged tsquery := ssil_tsquery('טיפול נפשי לבת 13', false);
BEGIN
  -- The age is gone and the words that carry the meaning are still required.
  IF aged::text LIKE '%13%' THEN
    RAISE EXCEPTION 'the age is still a requirement: %', aged;
  END IF;
  IF aged::text NOT LIKE '%נפשי%' THEN
    RAISE EXCEPTION 'dropping the age took the rest of the query with it: %', aged;
  END IF;

  -- A query that is nothing but a number still searches for it.
  IF ssil_tsquery('1201', false)::text NOT LIKE '%1201%' THEN
    RAISE EXCEPTION 'a number-only query lost its only term';
  END IF;

  -- And the relaxed form follows the same rule.
  IF ssil_tsquery_any('נפשי 13', false)::text LIKE '%13%' THEN
    RAISE EXCEPTION 'the relaxed query still requires the age';
  END IF;
END
$$;
