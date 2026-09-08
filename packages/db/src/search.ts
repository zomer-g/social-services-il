import { query } from './pool.js';

/**
 * Card search.
 *
 * One statement does filtering, ranking, distance and facet counts, because
 * these are not independent: the facet counts have to describe the same result
 * set the page is showing, and a second round trip to compute them is both
 * slower and a chance for the two to disagree.
 */

export interface SearchParams {
  /** Free text, as typed. Normalised inside Postgres. */
  q?: string | undefined;
  /** Response taxonomy ids. Matching is inclusive of descendants. */
  responses?: string[] | undefined;
  situations?: string[] | undefined;
  /** Rank by proximity to this point and report distances. */
  lat?: number | undefined;
  lon?: number | undefined;
  /** Hard cutoff in kilometres. Without one, nearby simply ranks higher. */
  radiusKm?: number | undefined;
  /** [west, south, east, north] — used by the map viewport. */
  bbox?: [number, number, number, number] | undefined;
  city?: string | undefined;
  organizationId?: string | undefined;
  /** 'only' for nationwide services alone, 'exclude' to drop them. */
  nationalService?: 'only' | 'exclude' | undefined;
  /**
   * Collapse identical offerings from different organizations onto one row.
   * On by default: a nationwide food programme run by forty nonprofits should
   * be one result, not forty.
   */
  collapse?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  lang?: string | undefined;
}

export interface SearchResultCard {
  card_id: string;
  service_id: string;
  branch_id: string | null;
  organization_id: string;
  service_name: string;
  service_description: string | null;
  organization_name: string;
  organization_short_name: string | null;
  organization_kind: string | null;
  branch_name: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  national_service: boolean;
  location_accurate: boolean;
  phone_numbers: string[];
  response_ids: string[];
  situation_ids: string[];
  score: number;
  distance_m: number | null;
  /** How many further cards this one stands for after collapsing. */
  also_offered_by: number;
  updated_at: string;
}

export interface FacetBucket {
  id: string;
  name: string | null;
  count: number;
}

export interface SearchResponse {
  total: number;
  cards: SearchResultCard[];
  facets: { responses: FacetBucket[]; situations: FacetBucket[]; cities: FacetBucket[] };
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
/** Distance at which the proximity term has fallen to half. */
const PROXIMITY_HALF_LIFE_KM = 5;

export async function searchCards(params: SearchParams): Promise<SearchResponse> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);
  const collapse = params.collapse !== false;
  const lang = params.lang ?? 'he';

  const hasPoint = typeof params.lat === 'number' && typeof params.lon === 'number';
  const q = params.q?.trim() || null;

  // Parameters are positional so the statement text stays constant across
  // calls and Postgres can reuse its plan.
  const args: unknown[] = [
    q, // $1
    params.responses?.length ? params.responses : null, // $2
    params.situations?.length ? params.situations : null, // $3
    hasPoint ? params.lon : null, // $4
    hasPoint ? params.lat : null, // $5
    params.radiusKm != null ? params.radiusKm * 1000 : null, // $6
    params.bbox ?? null, // $7
    params.city ?? null, // $8
    params.organizationId ?? null, // $9
    params.nationalService ?? null, // $10
    limit, // $11
    offset, // $12
    lang, // $13
  ];

  const sql = `
    WITH q AS (
      SELECT
        CASE WHEN $1::text IS NOT NULL THEN ssil_tsquery($1::text, true) END AS tsq,
        CASE WHEN $1::text IS NOT NULL THEN ssil_normalize($1::text) END AS qnorm,
        CASE WHEN $4::float8 IS NOT NULL
             THEN ST_SetSRID(ST_MakePoint($4::float8, $5::float8), 4326)::geography
        END AS origin
    ),
    filtered AS (
      SELECT c.*,
        (q.origin IS NOT NULL) AS has_origin,
        CASE WHEN q.origin IS NOT NULL AND c.geom IS NOT NULL
             THEN ST_Distance(c.geom, q.origin) END AS distance_m,
        CASE WHEN q.tsq IS NOT NULL
             THEN ts_rank_cd(c.search_doc, q.tsq, 32) END AS text_rank,
        CASE WHEN q.qnorm IS NOT NULL
             THEN similarity(c.search_text, q.qnorm) END AS trgm
      FROM cards c, q
      WHERE
        -- Free text: the index match is the gate; trigram similarity only
        -- rescues a near miss, so a typo still finds the record.
        (q.tsq IS NULL OR c.search_doc @@ q.tsq OR c.search_text % q.qnorm)
        AND ($2::text[] IS NULL OR c.response_ids_all && $2::text[])
        AND ($3::text[] IS NULL OR c.situation_ids_all && $3::text[])
        AND ($8::text IS NULL OR c.city = $8::text)
        AND ($9::text IS NULL OR c.organization_id = $9::text)
        AND ($10::text IS NULL
             OR ($10 = 'only' AND c.national_service)
             OR ($10 = 'exclude' AND NOT c.national_service))
        -- A radius or a viewport must not hide nationwide services: they are
        -- available at that location too, they just have no pin.
        AND ($6::float8 IS NULL OR c.national_service
             OR (c.geom IS NOT NULL AND ST_DWithin(c.geom, q.origin, $6::float8)))
        AND ($7::float8[] IS NULL OR c.national_service
             OR (c.geom IS NOT NULL AND ST_Intersects(
                   c.geom::geometry,
                   ST_MakeEnvelope(
                     ($7::float8[])[1], ($7::float8[])[2],
                     ($7::float8[])[3], ($7::float8[])[4], 4326))))
    ),
    ranked AS (
      SELECT f.*,
        -- Three additive terms, each on its own 0..1-ish scale, so the weights
        -- mean something: how well the words match, how substantial the service
        -- is, and how close it is.
        COALESCE(f.text_rank, 0) * 6
          + COALESCE(f.trgm, 0) * 2
          + ln(1 + f.score) * 0.5
          + CASE
              WHEN f.distance_m IS NOT NULL
                THEN 3.0 / (1 + (f.distance_m / 1000.0) / ${PROXIMITY_HALF_LIFE_KM})
              -- A nationwide service is reachable from anywhere, so it sits at
              -- the value a moderately near branch would score rather than
              -- being pushed below everything with a pin.
              WHEN f.national_service AND f.has_origin THEN 1.2
              ELSE 0
            END AS rank
      FROM filtered f
    ),
    grouped AS (
      SELECT r.*,
        CASE WHEN $14::boolean
             THEN row_number() OVER (PARTITION BY r.collapse_key ORDER BY r.rank DESC, r.score DESC)
             ELSE 1 END AS dup_rank,
        CASE WHEN $14::boolean
             THEN count(*) OVER (PARTITION BY r.collapse_key)
             ELSE 1 END AS dup_count
      FROM ranked r
    ),
    visible AS (
      SELECT * FROM grouped WHERE dup_rank = 1
    )
    SELECT
      (SELECT count(*) FROM visible)::int AS total,
      -- The rank column orders the page but is dropped from the payload: it is
      -- an internal blend, and publishing it would imply a stable meaning it
      -- does not have across queries.
      (SELECT json_agg(to_jsonb(p) - 'rank' ORDER BY p.rank DESC, p.score DESC, p.card_id)
       FROM (
         SELECT v.card_id, v.service_id, v.branch_id, v.organization_id,
                v.service_name, v.service_description,
                v.organization_name, v.organization_short_name, v.organization_kind,
                v.branch_name, v.address, v.city,
                ST_Y(v.geom::geometry) AS lat, ST_X(v.geom::geometry) AS lon,
                v.national_service, v.location_accurate, v.phone_numbers,
                v.response_ids, v.situation_ids, v.score,
                round(v.distance_m)::int AS distance_m,
                (v.dup_count - 1)::int AS also_offered_by,
                v.updated_at, v.rank
         FROM visible v
         ORDER BY v.rank DESC, v.score DESC, v.card_id
         LIMIT $11 OFFSET $12
       ) p) AS cards,
      -- Facets describe the whole filtered set, not the page, so the counts
      -- still make sense on page four.
      (SELECT json_agg(b) FROM (
         SELECT node AS id, tn.name, count(*)::int AS count
         FROM visible v, unnest(v.response_ids_all) AS node
         LEFT JOIN taxonomy_names tn ON tn.node_id = node AND tn.lang = $13::text
         GROUP BY node, tn.name ORDER BY count(*) DESC LIMIT 40
       ) b) AS response_facets,
      (SELECT json_agg(b) FROM (
         SELECT node AS id, tn.name, count(*)::int AS count
         FROM visible v, unnest(v.situation_ids_all) AS node
         LEFT JOIN taxonomy_names tn ON tn.node_id = node AND tn.lang = $13::text
         GROUP BY node, tn.name ORDER BY count(*) DESC LIMIT 40
       ) b) AS situation_facets,
      (SELECT json_agg(b) FROM (
         SELECT v.city AS id, v.city AS name, count(*)::int AS count
         FROM visible v WHERE v.city IS NOT NULL
         GROUP BY v.city ORDER BY count(*) DESC LIMIT 30
       ) b) AS city_facets
  `;

  args.push(collapse); // $14

  const { rows } = await query<{
    total: number;
    cards: SearchResultCard[] | null;
    response_facets: FacetBucket[] | null;
    situation_facets: FacetBucket[] | null;
    city_facets: FacetBucket[] | null;
  }>(sql, args);

  const row = rows[0];
  return {
    total: row?.total ?? 0,
    cards: row?.cards ?? [],
    facets: {
      responses: row?.response_facets ?? [],
      situations: row?.situation_facets ?? [],
      cities: row?.city_facets ?? [],
    },
  };
}
