-- Turning what someone typed into a query.
--
-- Split out from the indexing side so both go through ssil_normalize and can
-- never disagree about what a word is.

-- A tsquery from free text: every token required, and the last one matched as a
-- prefix when `prefix` is set, so results appear while someone is still typing.
--
-- Building the tsquery by hand rather than with plainto_tsquery is what allows
-- the prefix, and it is safe because ssil_normalize has already reduced the
-- input to alphanumeric tokens separated by single spaces — there is nothing
-- left that tsquery syntax could interpret.
CREATE OR REPLACE FUNCTION ssil_tsquery(input text, prefix boolean DEFAULT true)
  RETURNS tsquery LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  toks text[];
  parts text[] := '{}';
  i int;
BEGIN
  toks := array_remove(string_to_array(ssil_normalize(input), ' '), '');
  IF toks IS NULL OR cardinality(toks) = 0 THEN
    RETURN NULL;
  END IF;

  FOR i IN 1 .. cardinality(toks) LOOP
    IF prefix AND i = cardinality(toks) THEN
      parts := parts || (toks[i] || ':*');
    ELSE
      parts := parts || toks[i];
    END IF;
  END LOOP;

  -- All terms required. Someone searching "מזון ירושלים" means both, and an OR
  -- query would bury the exact match under everything else in Jerusalem.
  RETURN to_tsquery('simple', array_to_string(parts, ' & '));
END;
$$;


-- How many published cards sit under each taxonomy node, counting descendants.
--
-- Maintained rather than computed on demand: a suggestion list needs the count
-- for every node at once, and doing that as a correlated scan over the card
-- table costs a full pass per node.
CREATE TABLE taxonomy_card_counts (
  node_id    text PRIMARY KEY REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  axis       ssil_axis NOT NULL,
  card_count int NOT NULL DEFAULT 0
);

CREATE INDEX taxonomy_card_counts_axis_idx ON taxonomy_card_counts (axis, card_count DESC);

-- Called after rebuild_cards(). Kept separate rather than folded into it so the
-- rebuild stays one readable statement.
CREATE OR REPLACE FUNCTION refresh_taxonomy_counts() RETURNS void AS $$
BEGIN
  TRUNCATE taxonomy_card_counts;
  INSERT INTO taxonomy_card_counts (node_id, axis, card_count)
  SELECT n.id, n.axis, COALESCE(c.n, 0)
  FROM taxonomy_nodes n
  LEFT JOIN (
    SELECT node_id, count(*)::int AS n FROM (
      SELECT unnest(response_ids_all) AS node_id FROM cards
      UNION ALL
      SELECT unnest(situation_ids_all) FROM cards
    ) x GROUP BY node_id
  ) c ON c.node_id = n.id
  WHERE n.active;
END;
$$ LANGUAGE plpgsql;


-- Autocomplete over the taxonomy: the fastest route from a phrase to the two
-- axes the corpus is actually organised by.
--
-- The card count is part of the ranking on purpose. A category no service is
-- tagged with is a dead end, and offering it wastes the one attempt someone in
-- distress is likely to make.
CREATE OR REPLACE VIEW taxonomy_suggestions AS
SELECT
  n.id,
  n.axis,
  n.depth,
  nm.lang,
  nm.name,
  COALESCE(cc.card_count, 0) AS card_count,
  ssil_normalize(nm.name || ' ' || COALESCE(syn.terms, '')) AS search_text
FROM taxonomy_nodes n
JOIN taxonomy_names nm ON nm.node_id = n.id
LEFT JOIN taxonomy_card_counts cc ON cc.node_id = n.id
LEFT JOIN LATERAL (
  SELECT string_agg(s.term, ' ') AS terms
  FROM taxonomy_synonyms s
  WHERE s.node_id = n.id AND s.lang = nm.lang
) syn ON true
WHERE n.active;
