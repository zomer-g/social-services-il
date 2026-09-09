-- The card date was still the import date, for a reason the last migration
-- introduced rather than fixed.
--
-- 014 defined it as GREATEST over the service, the branch and the organization.
-- Organizations have no source date — nothing upstream says when one last
-- changed — so that arm was o.updated_at, which is when we last wrote the row.
-- A bulk import writes every organization, so that arm was always today, and
-- GREATEST takes the largest. The source dates were present and correct and
-- lost every comparison: 16,371 cards, all stamped inside the two minutes the
-- import ran.
--
-- Two changes. The organization is dropped from the calculation entirely — a
-- charity's row being rewritten is not evidence that this service's phone
-- number changed, and it never should have been able to outvote a real date.
-- And when neither the service nor the branch carries a source date, the card
-- now says nothing instead of falling back to when we received it. That
-- fallback is how the original problem looked: a precise, confident date that
-- means "we ran an import", presented to somebody deciding whether to trust a
-- phone number.
--
-- GREATEST ignores NULLs, so a service with a date and a branch without one
-- still gets the service's.

ALTER TABLE cards ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE cards ALTER COLUMN updated_at DROP DEFAULT;

COMMENT ON COLUMN cards.updated_at IS
  'When the source last changed this service or its branch. NULL when no source said. Never the rebuild or import time.';

CREATE OR REPLACE FUNCTION ssil_card_date(
  service_source timestamptz,
  branch_source  timestamptz
) RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT GREATEST(service_source, branch_source);
$$;

DO $$
BEGIN
  IF ssil_card_date(NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'a card with no source date must have no date';
  END IF;
  IF ssil_card_date('2026-02-18'::timestamptz, NULL) <> '2026-02-18'::timestamptz THEN
    RAISE EXCEPTION 'a known date must survive an unknown one';
  END IF;
  IF ssil_card_date('2024-01-01'::timestamptz, '2026-02-18'::timestamptz) <> '2026-02-18'::timestamptz THEN
    RAISE EXCEPTION 'the later of the two source dates must win';
  END IF;
END
$$;


-- rebuild_cards() again, with the date expression from 017 above.
--
-- Restated in full because Postgres has no way to patch part of a function.

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
    SELECT s.id AS service_id, b.id AS branch_id, b.organization_id
    FROM services s
    JOIN service_branches sb ON sb.service_id = s.id
    JOIN branches b ON b.id = sb.branch_id
    WHERE s.status = 'published' AND b.status = 'published'

    UNION

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
      ssil_clean_city(l.resolved_city) AS city,
      l.geom,
      (p.branch_id IS NULL OR COALESCE(l.national_service, false)) AS national_service,
      COALESCE(l.location_accurate, false) AS location_accurate,
      ssil_clean_phones(
        s.phone_numbers || COALESCE(b.phone_numbers, '{}'::text[]) || o.phone_numbers
      ) AS phone_numbers,
      -- When the source last said this changed, or nothing. See migration 017
      -- for why the organization takes no part in this.
      ssil_card_date(s.source_updated_at, b.source_updated_at) AS record_updated_at,
      s.boost,
      COALESCE((
        SELECT array_agg(DISTINCT t.node_id) FROM tmp_tags t
        WHERE t.entity_type = 'service' AND t.entity_id = s.id AND t.axis = 'response'
      ), '{}'::text[]) AS response_ids,
      COALESCE((
        SELECT array_agg(DISTINCT t.ancestor_id) FROM tmp_tags t
        WHERE t.entity_type = 'service' AND t.entity_id = s.id AND t.axis = 'response'
      ), '{}'::text[]) AS response_ids_all,
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
    score, collapse_key, search_doc, search_text, updated_at
  )
  SELECT
    a.card_id, a.service_id, a.branch_id, a.organization_id,
    a.service_name, a.service_description,
    a.organization_name, a.organization_short_name, a.organization_kind, a.organization_branch_count,
    a.branch_name, a.address, a.city, a.geom, a.national_service, a.location_accurate,
    a.phone_numbers,
    a.response_ids, a.situation_ids, a.response_ids_all, a.situation_ids_all,
    ssil_card_score(
      a.service_description IS NOT NULL AND length(a.service_description) > 5,
      a.national_service,
      a.phone_numbers,
      a.organization_kind,
      a.organization_branch_count,
      a.boost
    ),
    btrim(regexp_replace(a.service_name || ' ' || COALESCE(a.service_description, ''), '[[:space:]]+', ' ', 'g')),
    setweight(to_tsvector('simple', ssil_normalize(a.service_name || ' ' || COALESCE(a.organization_short_name, a.organization_name))), 'A') ||
    setweight(to_tsvector('simple', ssil_normalize(ssil_tag_text(a.response_ids || a.situation_ids))), 'B') ||
    setweight(to_tsvector('simple', ssil_normalize(COALESCE(a.service_description, ''))), 'C') ||
    setweight(to_tsvector('simple', ssil_normalize(COALESCE(a.city, '') || ' ' || COALESCE(a.address, '') || ' ' || a.organization_name)), 'D'),
    ssil_normalize(
      a.service_name || ' ' || COALESCE(a.service_description, '') || ' ' ||
      a.organization_name || ' ' || COALESCE(a.organization_short_name, '') || ' ' ||
      COALESCE(a.city, '') || ' ' || ssil_tag_text(a.response_ids || a.situation_ids)
    ),
    a.record_updated_at
  FROM assembled a
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

INSERT INTO system_state (key, value)
VALUES ('cards_need_rebuild', 'card dates recomputed from the source, without the organization write time')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
