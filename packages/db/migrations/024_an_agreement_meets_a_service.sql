-- An agreement meets a service.
--
-- A contracting agreement between an authority and a provider describes a real
-- service, but it is not itself a record of one: the same service usually
-- already exists here, arriving earlier from a different source, and the
-- agreement is a second sighting of it rather than a new thing in the world.
--
-- Treating every agreement as a new service would duplicate the corpus. Treating
-- every near-match as the same service would silently merge two different
-- programmes that happen to share a name. So the decision is made explicitly,
-- recorded, and reversible: `service_links` holds the claim "this agreement is
-- about that service", who made it, how confident it was and on what evidence.
-- A link that turns out to be wrong is rejected, and the agreement can then be
-- pushed as the new service it actually describes.

CREATE TABLE IF NOT EXISTS service_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  text NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  source_id   uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  -- The document's id in the source system — the agreement number, usually.
  -- Together with the source this is what makes re-running the pipeline
  -- idempotent: the same agreement always lands on the same link row.
  external_id text NOT NULL,
  kind        text NOT NULL DEFAULT 'agreement',
  -- Human-readable, so the admin's list is readable without opening each row.
  title       text,
  -- 0-1, as reported by whatever proposed the link. NULL when a person made the
  -- call by hand, because a number there would imply a measurement nobody took.
  confidence  numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  method      text NOT NULL DEFAULT 'matcher'
              CHECK (method IN ('matcher', 'manual', 'declared')),
  -- What the decision was made on: component scores, the runner-up, the
  -- agreement's parties and dates. Kept so a link can be re-judged later
  -- without re-reading the document.
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'proposed'
              CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  note        text,
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- One claim per (source, document, service). A second push of the same
  -- agreement updates the claim rather than stacking another copy of it.
  UNIQUE (source_id, external_id, service_id)
);

CREATE INDEX IF NOT EXISTS service_links_service_idx ON service_links (service_id);
CREATE INDEX IF NOT EXISTS service_links_pending_idx ON service_links (status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_links_document_idx ON service_links (source_id, external_id);


/**
 * The dialable form of a phone number, for comparison only.
 *
 * Two records describing the same desk write its number four different ways —
 * "02-1234567", "021234567", "+972-2-1234567", "972 2 1234567" — and a shared
 * number is one of the few near-certain signals that two records are about the
 * same place. Comparing them as written finds none of them.
 *
 * The country code collapses back to the leading zero rather than being
 * stripped, so the international and local spellings of one number meet.
 */
CREATE OR REPLACE FUNCTION ssil_phone_key(phone text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(
    regexp_replace(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '^9720?', '0'),
    ''
  );
$$;

DO $$
BEGIN
  IF ssil_phone_key('+972-2-1234567') <> ssil_phone_key('02-1234567') THEN
    RAISE EXCEPTION 'ssil_phone_key does not fold the country code: % vs %',
      ssil_phone_key('+972-2-1234567'), ssil_phone_key('02-1234567');
  END IF;
  IF ssil_phone_key('972521234567') <> '0521234567' THEN
    RAISE EXCEPTION 'ssil_phone_key mishandled a mobile number: %', ssil_phone_key('972521234567');
  END IF;
  -- A number that is not one must not become a key that matches every other
  -- record with no number.
  IF ssil_phone_key('') IS NOT NULL OR ssil_phone_key('SMS') IS NOT NULL THEN
    RAISE EXCEPTION 'ssil_phone_key returned a key for a non-number';
  END IF;
END
$$;


/**
 * The host of a URL, without scheme, www or path.
 *
 * Two records pointing at the same page of the same site are usually about the
 * same service; two pointing at the same domain are at least about the same
 * body. The host is the part that carries that, and the only part that survives
 * one source storing a tracking suffix the other does not.
 */
CREATE OR REPLACE FUNCTION ssil_url_host(url text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(
    lower(regexp_replace(regexp_replace(coalesce(url, ''), '^[a-zA-Z]+://', ''), '^(www\.)?([^/?#]*).*$', '\2')),
    ''
  );
$$;

DO $$
BEGIN
  IF ssil_url_host('https://www.Example.org.il/a/b?c=1') <> 'example.org.il' THEN
    RAISE EXCEPTION 'ssil_url_host is wrong: %', ssil_url_host('https://www.Example.org.il/a/b?c=1');
  END IF;
END
$$;


-- The matcher looks organizations up by name when it has no registration
-- number, which is a trigram comparison over every organization in the corpus.
CREATE INDEX IF NOT EXISTS organizations_name_trgm_idx
  ON organizations USING GIN (name gin_trgm_ops);
