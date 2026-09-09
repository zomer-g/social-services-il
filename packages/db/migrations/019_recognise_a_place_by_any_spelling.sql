-- The city filter was exact string equality, so the corpus's own spelling was
-- the only spelling that worked:
--
--     קריית ביאליק   2 results          קרית ביאליק    0
--     קרית מוצקין    3 results          קריית מוצקין   0
--     תל אביב-יפו    8 results          תל אביב יפו    0
--     פתח תקווה      4 results          פתח תקוה       0
--     חיפה           9 results          "חיפה "        0
--     נוף הגליל      7 results          נצרת עילית     0
--
-- Two neighbouring towns spelled with opposite conventions, a trailing space
-- enough to lose everything, and a town renamed in 2019 unreachable under the
-- name most people still use. An assistant cannot know which spelling this
-- corpus happens to hold, so it guesses, gets nothing, and reports that there
-- is nothing there — over a corpus that has it. That is most of why the
-- answers felt thin about places.
--
-- Three tiers, cheapest first, all local:
--
--   1. a normalised key, which absorbs spacing, hyphens, quotes, geresh,
--      case and Hebrew final forms;
--   2. an alias table, for what normalisation cannot reach — a rename, and the
--      Latin names sitting in the data;
--   3. trigram similarity against the corpus's own city list, which is what
--      settles כתיב מלא against כתיב חסר without anyone enumerating the pairs.
--
-- Tier 3 refuses to answer unless one candidate is a clear winner. Guessing
-- wrong sends somebody to a different town, which is worse than saying no.

CREATE OR REPLACE FUNCTION ssil_city_key(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(
    ssil_fold_finals(
      regexp_replace(lower(btrim(coalesce(input, ''))), '[^a-z0-9א-ת]', '', 'g')
    ),
    ''
  );
$$;

/**
 * What normalisation cannot reach: a name in another script, and a town that
 * changed its name. Both are content, not algorithm, so they are listed.
 */
CREATE TABLE IF NOT EXISTS city_aliases (
  alias_key text PRIMARY KEY,
  canonical text NOT NULL,
  note      text
);

INSERT INTO city_aliases (alias_key, canonical, note) VALUES
  -- Latin spellings that arrived in the data itself, and which no amount of
  -- Hebrew normalisation will ever join to their Hebrew twin.
  (ssil_city_key('Jerusalem'),               'ירושלים',            'latin in source'),
  (ssil_city_key('Tel Aviv-Yafo'),           'תל אביב-יפו',        'latin in source'),
  (ssil_city_key('Petah Tikva'),             'פתח תקווה',          'latin in source'),
  (ssil_city_key('Rishon LeZion'),           'ראשון לציון',        'latin in source'),
  (ssil_city_key('Rehovot'),                 'רחובות',             'latin in source'),
  (ssil_city_key('Be''er Sheva'),            'באר שבע',            'latin in source'),
  (ssil_city_key('Herzliya'),                'הרצליה',             'latin in source'),
  (ssil_city_key('Ramat Gan'),               'רמת גן',             'latin in source'),
  (ssil_city_key('Netivot'),                 'נתיבות',             'latin in source'),
  (ssil_city_key('Qiryat Shemona'),          'קרית שמונה',         'latin in source'),
  (ssil_city_key('Kiryat Bialik'),           'קריית ביאליק',       'latin in source'),
  (ssil_city_key('Kiryat Motzkin'),          'קרית מוצקין',        'latin in source'),
  (ssil_city_key('Baqa al-Gharbiyye'),       'באקה אל-ע''רביה',    'latin in source'),
  (ssil_city_key('Taibe'),                   'טייבה',              'latin in source'),
  (ssil_city_key('Reineh'),                  'ריינה',              'latin in source'),
  (ssil_city_key('nazarith'),                'נצרת',               'latin in source, misspelled'),
  (ssil_city_key('Tel Sheva'),               'תל שבע',             'latin in source'),
  (ssil_city_key('Omer'),                    'עומר',               'latin in source'),
  (ssil_city_key('Lahav'),                   'להב',                'latin in source'),
  (ssil_city_key('Ma''ale Efrayim'),         'מעלה אפרים',         'latin in source'),
  (ssil_city_key('Tko''a'),                  'תקוע',               'latin in source'),
  (ssil_city_key('Tsufin (Tsofim)'),         'צופים',              'latin in source'),
  (ssil_city_key('Ashdot Ya''akov Meuhad'),  'אשדות יעקב (מאוחד)', 'latin in source; a different kibbutz from אשדות יעקב איחוד'),
  -- Renamed in 2019. Most people, and most older records, still say the old one.
  (ssil_city_key('נצרת עילית'),              'נוף הגליל',          'renamed 2019'),
  -- Everyday short forms.
  (ssil_city_key('תל אביב'),                 'תל אביב-יפו',        'short form'),
  (ssil_city_key('ת"א'),                     'תל אביב-יפו',        'short form')
ON CONFLICT (alias_key) DO UPDATE SET canonical = EXCLUDED.canonical, note = EXCLUDED.note;

-- The corpus's own city names, keyed. Rebuilt alongside the cards, since that
-- is when the set of cities can change.
CREATE TABLE IF NOT EXISTS city_index (
  city_key text PRIMARY KEY,
  city     text NOT NULL,
  cards    int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS city_index_trgm ON city_index USING gin (city gin_trgm_ops);

CREATE OR REPLACE FUNCTION rebuild_city_index() RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  TRUNCATE city_index;
  INSERT INTO city_index (city_key, city, cards)
  SELECT ssil_city_key(city), min(city), count(*)::int
    FROM cards
   WHERE city IS NOT NULL AND ssil_city_key(city) IS NOT NULL
   GROUP BY ssil_city_key(city);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

/**
 * A place name in any spelling, answered with the one this corpus uses, or
 * NULL when nothing is close enough to be sure.
 *
 * The threshold and the requirement that the best candidate beat the runner-up
 * were set against the real failures above: "קרית ביאליק" must reach
 * "קריית ביאליק", while a name that is merely in the same region must reach
 * nothing at all.
 */
CREATE OR REPLACE FUNCTION ssil_resolve_city(input text) RETURNS text
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  k      text := ssil_city_key(input);
  hit    text;
  best   record;
  runner real;
BEGIN
  IF k IS NULL THEN RETURN NULL; END IF;

  -- 1. A name we have been told about explicitly. This runs BEFORE the corpus
  -- index, and the first version had it after — which made it dead code for
  -- exactly the cases it was written for. "Jerusalem" is itself a city string
  -- in this data, so the index matched it and returned it unchanged, and the
  -- alias that exists to say "that means ירושלים" never ran. An alias is a
  -- statement that the corpus's own spelling is not the one to answer with, so
  -- it has to outrank it.
  --
  -- It is returned only if the corpus actually holds the target, so a stale
  -- alias cannot invent a filter that matches nothing.
  SELECT ci.city INTO hit
    FROM city_aliases ca
    JOIN city_index ci ON ci.city_key = ssil_city_key(ca.canonical)
   WHERE ca.alias_key = k;
  IF hit IS NOT NULL THEN RETURN hit; END IF;

  -- 2. The corpus's own spelling, modulo punctuation and final forms.
  SELECT city INTO hit FROM city_index WHERE city_key = k;
  IF hit IS NOT NULL THEN RETURN hit; END IF;

  -- 3. Nearest by trigram, and only when it is not a close-run thing.
  SELECT city, similarity(city, btrim(input)) AS sim
    INTO best
    FROM city_index
   ORDER BY similarity(city, btrim(input)) DESC, cards DESC
   LIMIT 1;

  IF best IS NULL OR best.sim < 0.62 THEN RETURN NULL; END IF;

  SELECT max(similarity(city, btrim(input))) INTO runner
    FROM city_index WHERE city <> best.city;

  IF runner IS NOT NULL AND best.sim - runner < 0.05 THEN
    RETURN NULL;  -- two towns equally close; picking one would be a guess
  END IF;

  RETURN best.city;
END;
$$;

SELECT rebuild_city_index();

DO $$
BEGIN
  IF ssil_city_key('חיפה ') <> ssil_city_key('חיפה') THEN
    RAISE EXCEPTION 'a trailing space still changes the key';
  END IF;
  IF ssil_city_key('תל אביב-יפו') <> ssil_city_key('תל אביב יפו') THEN
    RAISE EXCEPTION 'a hyphen still changes the key';
  END IF;
  -- A warning, not an exception. This tier depends on a similarity threshold
  -- against live data, and a migration that can abort on a tuning constant
  -- takes the whole server down with it at boot. The deterministic tiers above
  -- are asserted; this one is reported and checked from outside.
  IF ssil_resolve_city('קרית ביאליק') IS DISTINCT FROM 'קריית ביאליק' THEN
    RAISE WARNING 'trigram tier: קרית ביאליק resolved to % (similarity %)',
      coalesce(ssil_resolve_city('קרית ביאליק'), '(null)'),
      (SELECT max(similarity(city, 'קרית ביאליק')) FROM city_index);
  END IF;
  IF ssil_resolve_city('נצרת עילית') <> 'נוף הגליל' THEN
    RAISE EXCEPTION 'the 2019 rename is not followed, got %', coalesce(ssil_resolve_city('נצרת עילית'), '(null)');
  END IF;
  -- Also a warning: at the moment this migration runs the cards still carry the
  -- Latin names, and it is the rebuild afterwards that replaces them.
  IF ssil_resolve_city('Jerusalem') IS DISTINCT FROM 'ירושלים' THEN
    RAISE WARNING 'Jerusalem resolved to % (expected ירושלים after the rebuild)',
      coalesce(ssil_resolve_city('Jerusalem'), '(null)');
  END IF;
END
$$;

/**
 * Cards and the town list are one operation, not two.
 *
 * The list of towns is derived from the cards, so it is only correct in the
 * moment just after they are built. There are five places in the server that
 * rebuild cards; asking each of them to remember a second call is how the
 * resolver ends up answering from a list one import out of date, which would
 * show up as a town that quietly stopped being findable.
 */
CREATE OR REPLACE FUNCTION rebuild_all() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  built integer;
BEGIN
  built := rebuild_cards();

  -- Apply the alias list to the data, so no card is left carrying a name the
  -- resolver will never answer with. Without this the 96 cards whose city is
  -- "Jerusalem" become unreachable by either name: a search for ירושלים
  -- excludes them, and a search for Jerusalem is resolved to ירושלים and
  -- excludes them too.
  UPDATE cards c
     SET city = ca.canonical
    FROM city_aliases ca
   WHERE ssil_city_key(c.city) = ca.alias_key
     AND c.city IS DISTINCT FROM ca.canonical;

  PERFORM rebuild_city_index();
  RETURN built;
END;
$$;

INSERT INTO system_state (key, value)
VALUES ('cards_need_rebuild', 'build the town list that city resolution reads')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
