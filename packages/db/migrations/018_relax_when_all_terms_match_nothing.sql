-- "אוכל חינם בירושלים" — free food in Jerusalem — returned nothing, over a
-- corpus holding 391 food services.
--
-- Every term is required, and that is the right default: someone searching
-- "מזון ירושלים" means both words, and an OR query would bury the Jerusalem
-- food bank under everything else in Jerusalem. But when all the terms together
-- match nothing there is no such thing to protect, and the search was going
-- straight to the trigram pass — which exists to rescue a misspelling and can
-- do nothing at all about a query whose words are each spelled correctly and
-- simply never occur together.
--
-- So a query becomes narrower and narrower until it falls off a cliff:
--
--     מזון              169 results
--     אוכל              391
--     אוכל חינם           4      -- "חינם" is a qualifier, not a requirement
--     אוכל חינם + ירושלים  0      -- nothing at all
--
-- The last line is what an assistant reads back to somebody as "I could not
-- find anything", and it is why the answers felt thin. The corpus was never the
-- problem.
--
-- ssil_tsquery_any is the same tokenizer — same stopwords, same final-form
-- folding, same prefix-variant groups — combined with | instead of &. It is
-- used only after the strict pass has returned nothing, and ts_rank_cd then
-- puts the cards matching more of the terms first, so the relaxation costs
-- nothing in ordering.

CREATE OR REPLACE FUNCTION ssil_tsquery_build(input text, prefix boolean, combine text)
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

/** All terms required. The default, and what almost every search uses. */
CREATE OR REPLACE FUNCTION ssil_tsquery(input text, prefix boolean DEFAULT true)
  RETURNS tsquery LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ssil_tsquery_build(input, prefix, ' & ');
$$;

/** Any term. Only for a query whose terms match nothing together. */
CREATE OR REPLACE FUNCTION ssil_tsquery_any(input text, prefix boolean DEFAULT true)
  RETURNS tsquery LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ssil_tsquery_build(input, prefix, ' | ');
$$;

DO $$
DECLARE
  strict_q tsquery := ssil_tsquery('אוכל חינם');
  loose_q  tsquery := ssil_tsquery_any('אוכל חינם');
BEGIN
  -- The strict form must still be strict; the relaxation must be real.
  IF strict_q::text NOT LIKE '%&%' THEN
    RAISE EXCEPTION 'the strict query stopped requiring every term: %', strict_q;
  END IF;
  IF loose_q::text LIKE '%&%' OR loose_q::text NOT LIKE '%|%' THEN
    RAISE EXCEPTION 'the relaxed query is not relaxed: %', loose_q;
  END IF;
  -- Both must survive the prefix-variant machinery on a word carrying a particle.
  IF ssil_tsquery_any('למזון') IS NULL THEN
    RAISE EXCEPTION 'the relaxed query lost the prefix variants';
  END IF;
END
$$;
