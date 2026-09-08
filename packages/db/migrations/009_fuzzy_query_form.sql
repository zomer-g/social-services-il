-- A plain normalisation, for the fuzzy side of a search.
--
-- ssil_normalize expands each token into two forms — as written and with a
-- leading particle removed — because the index has to be able to meet a query
-- whichever way the word was spelled. That is right for full-text matching,
-- where the forms are separate lexemes and either can match.
--
-- It is wrong for trigram matching. There the query is one string compared
-- against the text, so "מקלת" becomes "מקלת קלת" and word similarity is asked to
-- find that two-word phrase rather than the single misspelled word someone
-- actually typed. The misspelling then rescues nothing, which is the one job the
-- fuzzy pass has.
--
-- This returns the folded tokens only, in the order they were typed.
CREATE OR REPLACE FUNCTION ssil_normalize_plain(input text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(string_agg(tok, ' ' ORDER BY ord), '')
  FROM (
    SELECT ssil_fold_finals(t) AS tok, ord
    FROM unnest(ssil_tokens(input)) WITH ORDINALITY AS u(t, ord)
    WHERE t NOT IN (SELECT term FROM search_stopwords)
  ) f
  WHERE length(tok) > 1;
$$;

DO $$
BEGIN
  IF ssil_normalize_plain('מקלת') <> 'מקלת' THEN
    RAISE EXCEPTION 'ssil_normalize_plain should not expand prefix variants, got "%"',
      ssil_normalize_plain('מקלת');
  END IF;

  -- Word order is what makes a multi-word misspelling recognisable.
  IF ssil_normalize_plain('ניצולי שאוה') <> 'ניצולי שאוה' THEN
    RAISE EXCEPTION 'ssil_normalize_plain lost word order, got "%"',
      ssil_normalize_plain('ניצולי שאוה');
  END IF;
END
$$;
