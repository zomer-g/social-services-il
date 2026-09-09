-- Three data problems that only became visible once an assistant was reading
-- this corpus out loud to people.
--
-- 1. Every card claimed to have been updated at the same instant.
--
--    cards.updated_at defaulted to now(), so a rebuild stamped all 16,371 rows
--    with the moment the rebuild ran. The MCP server tells assistants to relay
--    that date so a person can judge whether to trust a phone number — which
--    made it worse than useless: a confident, precise, meaningless date.
--
--    Records now carry when the source last changed them, where the source told
--    us, falling back to when we last received them.
--
-- 2. "0" was being served as a phone number, along with "SMS" and "וואטסאפ)".
--    2,031 such values, and 251 cards where that was the only number on offer.
--    An assistant reads them out as something to dial.
--
-- 3. 1,555 cards gave their city as the literal string "unknown", which then
--    appears in an answer as the place to go.

ALTER TABLE services ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;

COMMENT ON COLUMN services.source_updated_at IS
  'When the upstream source last changed this record, where it says so. Distinct from updated_at, which is when we last wrote it.';

/**
 * Keeps only values that could actually be dialled.
 *
 * Three digits is the floor because the shortest real numbers here are the
 * national emergency lines (100, 101, 102). Anything with fewer digits, or with
 * none, is a note that ended up in a phone column.
 */
CREATE OR REPLACE FUNCTION ssil_clean_phones(phones text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    array_agg(DISTINCT p ORDER BY p) FILTER (
      WHERE length(regexp_replace(p, '\D', '', 'g')) >= 3
        AND regexp_replace(p, '\D', '', 'g') !~ '^0+$'
    ),
    '{}'
  )
  FROM unnest(COALESCE(phones, '{}')) AS p;
$$;

/** A placeholder is worse than an absence: it reads as a real answer. */
CREATE OR REPLACE FUNCTION ssil_clean_city(city text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN city IS NULL THEN NULL
    WHEN btrim(lower(city)) IN ('unknown', 'null', 'n/a', '-', 'לא ידוע', 'לא ידועה') THEN NULL
    WHEN btrim(city) = '' THEN NULL
    ELSE btrim(city)
  END;
$$;

DO $$
BEGIN
  IF ssil_clean_phones(ARRAY['0', 'SMS', '02-6297720', '1201', '', '000']) <> ARRAY['02-6297720', '1201'] THEN
    RAISE EXCEPTION 'phone cleaning is wrong: %', ssil_clean_phones(ARRAY['0', 'SMS', '02-6297720', '1201', '', '000']);
  END IF;
  IF ssil_clean_city('unknown') IS NOT NULL OR ssil_clean_city('חיפה') <> 'חיפה' THEN
    RAISE EXCEPTION 'city cleaning is wrong';
  END IF;
END
$$;

-- Applied at rebuild rather than to the stored entities: the raw value is what
-- the source sent, and an editor looking at why a phone number vanished should
-- be able to see it.
INSERT INTO system_state (key, value)
VALUES ('cards_need_rebuild', 'record freshness and junk filtering')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
