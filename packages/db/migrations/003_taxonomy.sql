-- The taxonomy, and the tags that attach entities to it.
--
-- Two axes: what a service provides (`response`) and who it is for
-- (`situation`). Node ids are the hierarchical colon-delimited slug from the
-- openeligibility project, e.g. `human_services:food:soup_kitchen`, so ids
-- minted here match the ones already in circulation.
--
-- Names and synonyms are stored per language rather than as columns on the
-- node. The upstream YAML carries Hebrew and English only and no synonyms at
-- all; Arabic, Russian and the synonym lists are content this project owns, and
-- they are the single biggest lever on whether Hebrew search finds anything.

CREATE TYPE ssil_axis AS ENUM ('response', 'situation');

-- Where a tag came from. This decides conflicts: `manual` always wins, and an
-- `llm` suggestion never reaches the public site — a human promotes it to
-- `manual` first, or it stays a suggestion.
CREATE TYPE ssil_tag_origin AS ENUM ('source', 'rule', 'llm', 'manual');

CREATE TABLE taxonomy_nodes (
  id         text PRIMARY KEY,
  axis       ssil_axis NOT NULL,
  parent_id  text REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  -- Cached depth so a breadcrumb does not need a recursive query.
  depth      int NOT NULL,
  -- The stable uuid the upstream taxonomy assigns each node. Survives a slug
  -- rename, which is how we follow one upstream.
  pk_uuid    text,
  sort_order int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX taxonomy_nodes_axis_idx ON taxonomy_nodes (axis, active);
CREATE INDEX taxonomy_nodes_parent_idx ON taxonomy_nodes (parent_id);
CREATE UNIQUE INDEX taxonomy_nodes_pk_uuid_idx ON taxonomy_nodes (pk_uuid) WHERE pk_uuid IS NOT NULL;


CREATE TABLE taxonomy_names (
  node_id     text NOT NULL REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  lang        text NOT NULL,
  name        text NOT NULL,
  description text,
  PRIMARY KEY (node_id, lang)
);


CREATE TABLE taxonomy_synonyms (
  node_id text NOT NULL REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  lang    text NOT NULL,
  -- What people actually type. "קצבה", "דמי אבטלה", "ביטוח לאומי" all lead to
  -- the same node even though none of them is its name.
  term    text NOT NULL,
  PRIMARY KEY (node_id, lang, term)
);

CREATE INDEX taxonomy_synonyms_term_idx ON taxonomy_synonyms USING GIN (term gin_trgm_ops);


-- Tags on services, branches and organizations alike. Branch- and
-- organization-level situation tags exist because some qualifications belong to
-- the site or the body rather than the offering: a branch may be the one that
-- serves Arabic speakers, whoever runs it.
CREATE TABLE entity_taxonomy (
  entity_type text NOT NULL CHECK (entity_type IN ('service', 'branch', 'organization')),
  entity_id   text NOT NULL,
  node_id     text NOT NULL REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  axis        ssil_axis NOT NULL,
  origin      ssil_tag_origin NOT NULL DEFAULT 'source',
  -- 0..1, meaningful for `rule` and `llm` origins. A low-confidence tag lands
  -- in the admin's tagging queue instead of on the card.
  confidence  real,
  -- Who or what applied it: a user id, a rule name, or a model id.
  actor       text,
  -- The model's stated reason, kept so a reviewer can judge the suggestion
  -- rather than just accept it.
  rationale   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, node_id)
);

CREATE INDEX entity_taxonomy_node_idx ON entity_taxonomy (node_id, axis);
CREATE INDEX entity_taxonomy_entity_idx ON entity_taxonomy (entity_type, entity_id);
-- Drives the admin tagging queue.
CREATE INDEX entity_taxonomy_pending_idx ON entity_taxonomy (origin, confidence)
  WHERE origin IN ('llm', 'rule');


-- Every ancestor of every node, including the node itself at distance 0.
-- Filtering by a broad category ("housing") has to match services tagged with a
-- leaf ("assisted living"), and a recursive CTE per query is too slow to do
-- that inside a faceted search. Rebuilt whenever the taxonomy changes.
CREATE TABLE taxonomy_closure (
  ancestor_id   text NOT NULL REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  descendant_id text NOT NULL REFERENCES taxonomy_nodes (id) ON DELETE CASCADE,
  distance      int NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);

CREATE INDEX taxonomy_closure_descendant_idx ON taxonomy_closure (descendant_id);

CREATE OR REPLACE FUNCTION rebuild_taxonomy_closure() RETURNS void AS $$
BEGIN
  DELETE FROM taxonomy_closure;
  INSERT INTO taxonomy_closure (ancestor_id, descendant_id, distance)
  WITH RECURSIVE walk AS (
    SELECT id AS ancestor_id, id AS descendant_id, 0 AS distance FROM taxonomy_nodes
    UNION ALL
    SELECT w.ancestor_id, n.id, w.distance + 1
    FROM walk w
    JOIN taxonomy_nodes n ON n.parent_id = w.descendant_id
  )
  SELECT ancestor_id, descendant_id, distance FROM walk;
END;
$$ LANGUAGE plpgsql;
