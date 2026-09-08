-- Hebrew search normalisation, the denormalised card table, and the rebuild
-- that produces one from the other.
--
-- Postgres has no Hebrew stemmer, so normalisation is defined here, once, and
-- used by both the indexer and the query parser. Two implementations that drift
-- apart is the classic way to build a search engine that cannot find its own
-- documents, so this SQL is authoritative; the TypeScript in packages/core
-- mirrors it for client-side use and is tested against it.

-- Editable stopword list. These words appear in a large share of records and
-- carry no discriminating power: searching "שירות" should not match everything.
-- A table rather than a constant, so an editor can tune it as the corpus grows.
CREATE TABLE search_stopwords (
  lang text NOT NULL,
  term text NOT NULL,
  PRIMARY KEY (lang, term)
);

INSERT INTO search_stopwords (lang, term) VALUES
  ('he', 'עמותה'),
  ('he', 'שירות'),
  ('he', 'שירותים'),
  ('he', 'תוכנית'),
  ('he', 'טיפול'),
  ('he', 'קבוצה'),
  ('he', 'מרכז'),
  ('he', 'ארגון');


-- Hebrew marks that must vanish before tokenising: niqqud, cantillation, and
-- geresh/gershayim, which sit inside acronyms such as עו"ס and must not be
-- allowed to split the token. Separator marks are handled by ssil_split_marks
-- below; deleting those instead would fuse בית־ספר into one unmatchable token.
--
-- Done with translate() rather than a regex character range because ranges in
-- bracket expressions are interpreted through the database collation, and a
-- linguistic collation can order them in ways that quietly drop real letters.
-- translate() is a literal character map with no such dependency.
CREATE OR REPLACE FUNCTION ssil_strip_marks(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(
    COALESCE(t, ''),
    '֑֖֛֚֒֓֔֕֗֘֙֜֝֞֟֠'
    'ְ֢֣֤֥֦֧֪֭֮֡֨֩֫֬֯'
    'ֱֲֳִֵֶַָֹֺֻּֽֿׁׂ'
    'ׇׅׄ׳״'
    || chr(39) || chr(34),
    ''
  );
$$;

-- Hebrew marks that separate words rather than decorate them: the maqaf (the
-- hyphen in בית־ספר), paseq and sof pasuq, plus the dashes that arrive from
-- copied text. Turned into spaces, not deleted, so a hyphenated pair stays two
-- words instead of fusing into one token nothing will ever match.
CREATE OR REPLACE FUNCTION ssil_split_marks(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(COALESCE(t, ''), '־׀׃׆‐‑‒–—―', '          ');
$$;

-- Final letter forms folded to their medial form, so סניף and סניפים agree.
CREATE OR REPLACE FUNCTION ssil_fold_finals(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(t, 'ךםןףץ', 'כמנפצ');
$$;

-- Strips one leading particle (ו/ב/ל/כ/ה/מ/ש), but only when at least three
-- characters remain. Without that guard "מזון" loses its מ and collides with
-- unrelated words; over-stripping costs more precision than under-stripping
-- costs recall, since the trigram index still catches near misses.
CREATE OR REPLACE FUNCTION ssil_strip_prefix(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN length(t) >= 4 AND left(t, 1) IN (
      'ו', 'ב', 'ל', 'כ', 'ה', 'מ', 'ש')
      THEN substr(t, 2)
    ELSE t
  END;
$$;

-- Marks removed, punctuation turned into separators, then split on whitespace.
-- [[:punct:]] is safe here where a letter range would not be: no Hebrew, Arabic
-- or Cyrillic letter is punctuation under any collation, so nothing real is lost.
CREATE OR REPLACE FUNCTION ssil_tokens(input text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    array_remove(
      regexp_split_to_array(
        btrim(regexp_replace(lower(ssil_split_marks(ssil_strip_marks(input))), '[[:punct:][:space:]]+', ' ', 'g')),
        '[[:space:]]+'
      ),
      ''
    ),
    '{}'
  );
$$;

-- The canonical search form of a string. Used when building the index and when
-- parsing a query, so the two always agree.
CREATE OR REPLACE FUNCTION ssil_normalize(input text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(string_agg(tok, ' '), '')
  FROM (
    SELECT ssil_strip_prefix(ssil_fold_finals(t)) AS tok
    FROM unnest(ssil_tokens(input)) AS t
    WHERE t NOT IN (SELECT term FROM search_stopwords)
  ) s
  WHERE length(tok) > 1;
$$;


-- Prove the tokeniser actually works on this host before anything depends on
-- it. If a collation or a missing locale breaks Hebrew handling, the deploy
-- should fail here with a clear message rather than silently index nothing.
DO $$
DECLARE
  got text;
BEGIN
  got := ssil_normalize('בבית התמחוי');
  IF got <> 'בית תמחוי' THEN
    RAISE EXCEPTION 'ssil_normalize is broken on this host: expected "בית תמחוי", got "%"', got;
  END IF;

  got := array_to_string(ssil_tokens('עו"ס, ירושלים'), '|');
  IF got <> 'עוס|ירושלים' THEN
    RAISE EXCEPTION 'ssil_tokens is broken on this host: expected "עוס|ירושלים", got "%"', got;
  END IF;

  -- A stopword on its own normalises away entirely.
  IF ssil_normalize('שירות') <> '' THEN
    RAISE EXCEPTION 'stopword removal is not working';
  END IF;
END
$$;


-- Ranking, mirroring packages/core/src/scoring.ts. Plain arithmetic, so a
-- rebuild does not have to round-trip every row through the application.
CREATE OR REPLACE FUNCTION ssil_card_score(
  has_description boolean,
  national_service boolean,
  phone_numbers text[],
  organization_kind text,
  branch_count int,
  boost numeric
) RETURNS double precision LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  score double precision := 1;
BEGIN
  -- A service with no description cannot be acted on, so it ranks below one
  -- that can.
  IF has_description THEN score := score * 10; END IF;

  IF national_service THEN
    score := score * 10;
    -- A short or 1-800 number is a staffed hotline, not a desk phone.
    IF EXISTS (
      SELECT 1 FROM unnest(phone_numbers) p
      WHERE length(regexp_replace(p, '\D', '', 'g')) <= 6
         OR regexp_replace(p, '\D', '', 'g') LIKE '1%'
    ) THEN
      score := score * 5;
    END IF;
  ELSE
    -- Reach as a proxy for capacity, damped so a 500-branch chain cannot bury
    -- the one local organization that actually serves this neighbourhood.
    score := score * CASE
      WHEN branch_count > 100 THEN branch_count / 10.0
      ELSE sqrt(GREATEST(branch_count, 1))
    END;
  END IF;

  IF organization_kind IN ('משרד ממשלתי', 'רשות מקומית', 'תאגיד סטטוטורי') THEN
    score := score * 5;
  END IF;

  RETURN score * power(10, boost);
END;
$$;

-- Every name and synonym of a set of taxonomy nodes, in every language, as one
-- string. This is what lets a search for "קצבה" reach a node named "סיוע כספי".
CREATE OR REPLACE FUNCTION ssil_tag_text(node_ids text[]) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(string_agg(term, ' '), '')
  FROM (
    SELECT n.name AS term FROM taxonomy_names n WHERE n.node_id = ANY(node_ids)
    UNION
    SELECT sy.term FROM taxonomy_synonyms sy WHERE sy.node_id = ANY(node_ids)
  ) t;
$$;


-- The card: one service as offered at one place.
--
-- Denormalised on purpose. Search filters by taxonomy, ranks by score and sorts
-- by distance in a single pass over the whole corpus, and doing that across six
-- joins is what makes a search feel slow. Rebuilt from the entity tables on
-- publish.
CREATE TABLE cards (
  -- Eight hex characters of sha256(service_id:branch_id). Matches the id scheme
  -- already in public URLs, so existing links keep resolving.
  card_id                   text PRIMARY KEY,
  service_id                text NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  branch_id                 text REFERENCES branches (id) ON DELETE CASCADE,
  organization_id           text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  service_name              text NOT NULL,
  service_description       text,
  organization_name         text NOT NULL,
  organization_short_name   text,
  organization_kind         text,
  organization_branch_count int NOT NULL DEFAULT 1,
  branch_name               text,
  address                   text,
  city                      text,

  geom                      geography(Point, 4326),
  -- A service delivered anywhere in the country, with no point to show.
  national_service          boolean NOT NULL DEFAULT false,
  -- False when the pin is a city centroid rather than the real address; the
  -- card says so instead of implying precision it does not have.
  location_accurate         boolean NOT NULL DEFAULT false,

  phone_numbers             text[] NOT NULL DEFAULT '{}',
  -- Tags as assigned. Displayed on the card.
  response_ids              text[] NOT NULL DEFAULT '{}',
  situation_ids             text[] NOT NULL DEFAULT '{}',
  -- Tags plus every ancestor. Filtering by "housing" has to match a service
  -- tagged only "assisted living", and this is what makes that a single index hit.
  response_ids_all          text[] NOT NULL DEFAULT '{}',
  situation_ids_all         text[] NOT NULL DEFAULT '{}',

  score                     double precision NOT NULL DEFAULT 0,
  -- Service name plus description. Identical offerings from many organizations
  -- collapse onto one result rather than filling the page.
  collapse_key              text NOT NULL,

  search_doc                tsvector,
  -- Normalised plain text kept alongside the tsvector for trigram matching, so
  -- a misspelling still finds the record.
  search_text               text NOT NULL DEFAULT '',

  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cards_geom_idx ON cards USING GIST (geom);
CREATE INDEX cards_search_doc_idx ON cards USING GIN (search_doc);
CREATE INDEX cards_search_text_idx ON cards USING GIN (search_text gin_trgm_ops);
CREATE INDEX cards_responses_idx ON cards USING GIN (response_ids_all);
CREATE INDEX cards_situations_idx ON cards USING GIN (situation_ids_all);
CREATE INDEX cards_score_idx ON cards (score DESC);
CREATE INDEX cards_service_idx ON cards (service_id);
CREATE INDEX cards_branch_idx ON cards (branch_id);
CREATE INDEX cards_organization_idx ON cards (organization_id);
CREATE INDEX cards_collapse_idx ON cards (collapse_key);
CREATE INDEX cards_national_idx ON cards (national_service);
CREATE INDEX cards_city_idx ON cards (city);


-- Rows the rebuild deliberately discarded, so "why is my service not showing?"
-- has an answer in the admin instead of requiring someone to read this file.
CREATE TABLE card_rejections (
  service_id text NOT NULL,
  branch_id  text NOT NULL DEFAULT '',
  reason     text NOT NULL,
  detail     text,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, branch_id, reason)
);


CREATE OR REPLACE FUNCTION rebuild_cards() RETURNS integer AS $$
DECLARE
  built integer;
BEGIN
  DROP TABLE IF EXISTS tmp_branch_counts;
  DROP TABLE IF EXISTS tmp_tags;

  CREATE TEMP TABLE tmp_branch_counts ON COMMIT DROP AS
    SELECT organization_id, count(*)::int AS n
    FROM branches WHERE status = 'published'
    GROUP BY organization_id;

  -- Tags with their ancestors. LLM suggestions are excluded: they are proposals
  -- for a human to review, not published facts.
  CREATE TEMP TABLE tmp_tags ON COMMIT DROP AS
    SELECT et.entity_type, et.entity_id, et.axis, et.node_id, c.ancestor_id
    FROM entity_taxonomy et
    JOIN taxonomy_closure c ON c.descendant_id = et.node_id
    WHERE et.origin <> 'llm';

  CREATE INDEX ON tmp_tags (entity_type, entity_id, axis);
  ANALYZE tmp_tags;

  DELETE FROM card_rejections;
  TRUNCATE cards;

  WITH pairs AS (
    -- One card per (service, branch) the service is actually delivered at.
    SELECT s.id AS service_id, b.id AS branch_id, b.organization_id
    FROM services s
    JOIN service_branches sb ON sb.service_id = s.id
    JOIN branches b ON b.id = sb.branch_id
    WHERE s.status = 'published' AND b.status = 'published'

    UNION

    -- Plus a branchless card for an organization that offers the service with
    -- no site of its own — a helpline, or a nationwide programme.
    SELECT s.id, NULL::text, o.id
    FROM services s
    JOIN service_organizations so ON so.service_id = s.id
    JOIN organizations o ON o.id = so.organization_id
    WHERE s.status = 'published' AND o.status = 'published'
      AND NOT EXISTS (
        SELECT 1 FROM service_branches sb2
        JOIN branches b2 ON b2.id = sb2.branch_id
        WHERE sb2.service_id = s.id AND b2.organization_id = o.id
          AND b2.status = 'published'
      )
  ),
  assembled AS (
    SELECT
      substr(encode(sha256(convert_to(p.service_id || ':' || COALESCE(p.branch_id, ''), 'UTF8')), 'hex'), 1, 8) AS card_id,
      p.service_id, p.branch_id, p.organization_id,
      s.name AS service_name,
      s.description AS service_description,
      o.name AS organization_name,
      o.short_name AS organization_short_name,
      o.kind AS organization_kind,
      COALESCE(bc.n, 1) AS organization_branch_count,
      COALESCE(b.operating_unit, b.name) AS branch_name,
      COALESCE(l.resolved_address, b.address) AS address,
      l.resolved_city AS city,
      l.geom,
      -- Branchless cards are nationwide by construction; a branch is nationwide
      -- when its location says so.
      (p.branch_id IS NULL OR COALESCE(l.national_service, false)) AS national_service,
      COALESCE(l.location_accurate, false) AS location_accurate,
      (SELECT array_agg(DISTINCT ph) FROM unnest(
         s.phone_numbers || COALESCE(b.phone_numbers, '{}'::text[]) || o.phone_numbers
       ) AS ph WHERE ph <> '') AS phone_numbers,
      s.boost,
      COALESCE((
        SELECT array_agg(DISTINCT t.node_id) FROM tmp_tags t
        WHERE t.entity_type = 'service' AND t.entity_id = s.id AND t.axis = 'response'
      ), '{}'::text[]) AS response_ids,
      COALESCE((
        SELECT array_agg(DISTINCT t.ancestor_id) FROM tmp_tags t
        WHERE t.entity_type = 'service' AND t.entity_id = s.id AND t.axis = 'response'
      ), '{}'::text[]) AS response_ids_all,
      -- Situations merge across all three levels: some eligibility belongs to
      -- the site or the body rather than the offering.
      COALESCE((
        SELECT array_agg(DISTINCT t.node_id) FROM tmp_tags t
        WHERE t.axis = 'situation' AND (
          (t.entity_type = 'service' AND t.entity_id = s.id) OR
          (t.entity_type = 'branch' AND t.entity_id = p.branch_id) OR
          (t.entity_type = 'organization' AND t.entity_id = o.id))
      ), '{}'::text[]) AS situation_ids,
      COALESCE((
        SELECT array_agg(DISTINCT t.ancestor_id) FROM tmp_tags t
        WHERE t.axis = 'situation' AND (
          (t.entity_type = 'service' AND t.entity_id = s.id) OR
          (t.entity_type = 'branch' AND t.entity_id = p.branch_id) OR
          (t.entity_type = 'organization' AND t.entity_id = o.id))
      ), '{}'::text[]) AS situation_ids_all
    FROM pairs p
    JOIN services s ON s.id = p.service_id
    JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN branches b ON b.id = p.branch_id
    LEFT JOIN locations l ON l.id = b.location_id
    LEFT JOIN tmp_branch_counts bc ON bc.organization_id = o.id
  )
  INSERT INTO cards (
    card_id, service_id, branch_id, organization_id,
    service_name, service_description,
    organization_name, organization_short_name, organization_kind, organization_branch_count,
    branch_name, address, city, geom, national_service, location_accurate,
    phone_numbers, response_ids, situation_ids, response_ids_all, situation_ids_all,
    score, collapse_key, search_doc, search_text
  )
  SELECT
    a.card_id, a.service_id, a.branch_id, a.organization_id,
    a.service_name, a.service_description,
    a.organization_name, a.organization_short_name, a.organization_kind, a.organization_branch_count,
    a.branch_name, a.address, a.city, a.geom, a.national_service, a.location_accurate,
    COALESCE(a.phone_numbers, '{}'::text[]),
    a.response_ids, a.situation_ids, a.response_ids_all, a.situation_ids_all,
    ssil_card_score(
      a.service_description IS NOT NULL AND length(a.service_description) > 5,
      a.national_service,
      COALESCE(a.phone_numbers, '{}'::text[]),
      a.organization_kind,
      a.organization_branch_count,
      a.boost
    ),
    btrim(regexp_replace(a.service_name || ' ' || COALESCE(a.service_description, ''), '[[:space:]]+', ' ', 'g')),
    -- Weights: the name someone would say out loud outranks the taxonomy label,
    -- which outranks the prose, which outranks the address.
    setweight(to_tsvector('simple', ssil_normalize(a.service_name || ' ' || COALESCE(a.organization_short_name, a.organization_name))), 'A') ||
    setweight(to_tsvector('simple', ssil_normalize(ssil_tag_text(a.response_ids || a.situation_ids))), 'B') ||
    setweight(to_tsvector('simple', ssil_normalize(COALESCE(a.service_description, ''))), 'C') ||
    setweight(to_tsvector('simple', ssil_normalize(COALESCE(a.city, '') || ' ' || COALESCE(a.address, '') || ' ' || a.organization_name)), 'D'),
    ssil_normalize(
      a.service_name || ' ' || COALESCE(a.service_description, '') || ' ' ||
      a.organization_name || ' ' || COALESCE(a.organization_short_name, '') || ' ' ||
      COALESCE(a.city, '') || ' ' || ssil_tag_text(a.response_ids || a.situation_ids)
    )
  FROM assembled a
  -- A card with no point and no nationwide flag cannot answer "where do I go",
  -- so it is held back rather than shown at a guessed location. Every exclusion
  -- is recorded below and surfaces in the admin.
  WHERE (a.geom IS NOT NULL OR a.national_service)
    AND cardinality(a.response_ids) > 0;

  GET DIAGNOSTICS built = ROW_COUNT;

  INSERT INTO card_rejections (service_id, branch_id, reason, detail)
  SELECT DISTINCT s.id, '', 'no_response_tag',
         'The service has no response tag, so no route through the site can reach it.'
  FROM services s
  WHERE s.status = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM entity_taxonomy et
      WHERE et.entity_type = 'service' AND et.entity_id = s.id
        AND et.axis = 'response' AND et.origin <> 'llm')
  ON CONFLICT DO NOTHING;

  INSERT INTO card_rejections (service_id, branch_id, reason, detail)
  SELECT DISTINCT sb.service_id, b.id, 'unresolved_location',
         COALESCE(b.address, '(no address on record)')
  FROM service_branches sb
  JOIN branches b ON b.id = sb.branch_id AND b.status = 'published'
  LEFT JOIN locations l ON l.id = b.location_id
  WHERE l.geom IS NULL AND COALESCE(l.national_service, false) = false
  ON CONFLICT DO NOTHING;

  ANALYZE cards;
  RETURN built;
END;
$$ LANGUAGE plpgsql;
