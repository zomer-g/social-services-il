-- Keep the normalised text in the order it was written.
--
-- ssil_normalize aggregated its forms with no ORDER BY, so the word order of
-- every indexed document was whatever the planner happened to produce. Full-text
-- matching did not care — a tsvector is a bag of lexemes — but two things do.
--
-- Trigram matching does: word similarity scores a query against the best
-- matching stretch of the text, and a phrase can only be found if the words are
-- still next to each other. A misspelling of one word in a two-word phrase, like
-- "ניצולי שאוה", was unrescuable.
--
-- And reproducibility does: the same input should produce the same index entry
-- on every rebuild, or a diff of two rebuilds is meaningless.
--
-- Each token now contributes its written form followed by its de-prefixed form,
-- in the order the words were typed.
CREATE OR REPLACE FUNCTION ssil_normalize(input text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(string_agg(form, ' ' ORDER BY ord, variant), '')
  FROM (
    SELECT f.ord, v.variant, v.form
    FROM (
      SELECT ssil_fold_finals(t) AS folded, ord
      FROM unnest(ssil_tokens(input)) WITH ORDINALITY AS u(t, ord)
      WHERE t NOT IN (SELECT term FROM search_stopwords)
    ) f
    CROSS JOIN LATERAL (
      VALUES (1, f.folded), (2, ssil_strip_prefix(f.folded))
    ) AS v(variant, form)
    WHERE length(f.folded) > 1
      -- The de-prefixed form is dropped when stripping changed nothing, so a
      -- word that begins with a root letter is not indexed twice.
      AND (v.variant = 1 OR v.form <> f.folded)
      AND length(v.form) > 1
  ) ordered;
$$;

DO $$
DECLARE
  got text;
BEGIN
  -- Written form first, de-prefixed form second, words in the order typed.
  got := ssil_normalize('ניצולי שואה');
  IF got <> 'ניצולי שואה ואה' THEN
    RAISE EXCEPTION 'unexpected normalisation: "%"', got;
  END IF;

  -- The property the whole prefix scheme exists for still holds.
  IF NOT (string_to_array(ssil_normalize('מזון'), ' ')
          && string_to_array(ssil_normalize('למזון'), ' ')) THEN
    RAISE EXCEPTION 'prefix variants no longer meet';
  END IF;

  IF NOT (to_tsvector('simple', ssil_normalize('חלוקת מזון')) @@ ssil_tsquery('למזון', false)) THEN
    RAISE EXCEPTION 'a prefixed query no longer matches a plain document';
  END IF;

  -- And the same input still produces the same output.
  IF ssil_normalize('בית תמחוי לנזקקים') <> ssil_normalize('בית תמחוי לנזקקים') THEN
    RAISE EXCEPTION 'normalisation is not deterministic';
  END IF;
END
$$;

-- Every card's search_doc and search_text were built by the previous
-- normalisation. Flagged rather than rebuilt inline: the rebuild takes about a
-- minute on the real corpus, and migrations run before the server can answer
-- its health check.
INSERT INTO system_state (key, value) VALUES ('cards_need_rebuild', 'token order is now stable')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
