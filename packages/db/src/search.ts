import { query } from './pool.js';

/**
 * Card search.
 *
 * One statement does filtering, ranking, distance and facet counts, because
 * these are not independent: the facet counts have to describe the same result
 * set the page is showing, and a second round trip to compute them is both
 * slower and a chance for the two to disagree.
 *
 * The WHERE clause is assembled in JavaScript rather than written once with
 * `$1 IS NULL OR ...` guards. That idiom keeps the statement text constant, but
 * it also hides from the planner which filters are actually present, so an
 * indexable condition ends up inside an OR that can never use an index. On the
 * real corpus that turned every free-text search into a sequential scan
 * computing trigram similarity over every row — about 1.4 seconds, against tens
 * of milliseconds off the index. There are only a handful of distinct shapes, so
 * the planner now gets a fair description of each.
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

type MatchMode = 'none' | 'exact' | 'fuzzy';

export async function searchCards(params: SearchParams): Promise<SearchResponse> {
  const q = params.q?.trim() || undefined;

  // The index match is the fast path and answers almost everything. Trigram
  // similarity is the rescue for a misspelling, and it cannot share the index
  // with the full-text match, so it runs only when the exact pass found nothing
  // — which is precisely when someone needs it.
  const exact = await run(params, q ? 'exact' : 'none');
  if (q && exact.total === 0) {
    const fuzzy = await run(params, 'fuzzy');
    if (fuzzy.total > 0) return fuzzy;
  }
  return exact;
}

async function run(params: SearchParams, mode: MatchMode): Promise<SearchResponse> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);
  const collapse = params.collapse !== false;
  const lang = params.lang ?? 'he';
  const hasPoint = typeof params.lat === 'number' && typeof params.lon === 'number';
  const q = params.q?.trim() || undefined;

  const args: unknown[] = [];
  const p = (value: unknown): string => {
    args.push(value);
    return `$${args.length}`;
  };

  const where: string[] = [];
  let textRank = 'NULL::float4';
  let trgm = 'NULL::float4';

  if (mode !== 'none' && q) {
    const term = p(q);
    if (mode === 'exact') {
      // Written against the column directly, so the GIN index applies.
      where.push(`c.search_doc @@ ssil_tsquery(${term}, true)`);
      textRank = `ts_rank_cd(c.search_doc, ssil_tsquery(${term}, true), 32)`;
    } else {
      // word_similarity, not similarity. Plain `%` compares whole strings, so a
      // six-character query against a four-hundred-character document scores
      // near zero and a misspelling is never rescued. `<%` scores the query
      // against the closest word in the document, which is the question being
      // asked. The index applies to the right-hand side.
      where.push(`ssil_normalize(${term}) <% c.search_text`);
      trgm = `word_similarity(ssil_normalize(${term}), c.search_text)`;
    }
  }

  if (params.responses?.length) where.push(`c.response_ids_all && ${p(params.responses)}::text[]`);
  if (params.situations?.length) where.push(`c.situation_ids_all && ${p(params.situations)}::text[]`);
  if (params.city) where.push(`c.city = ${p(params.city)}`);
  if (params.organizationId) where.push(`c.organization_id = ${p(params.organizationId)}`);
  if (params.nationalService === 'only') where.push('c.national_service');
  if (params.nationalService === 'exclude') where.push('NOT c.national_service');

  let origin = 'NULL::geography';
  if (hasPoint) {
    origin = `ST_SetSRID(ST_MakePoint(${p(params.lon)}::float8, ${p(params.lat)}::float8), 4326)::geography`;
  }

  // A radius or a viewport must not hide nationwide services: they are
  // available at that location too, they just have no pin.
  if (hasPoint && params.radiusKm != null) {
    where.push(
      `(c.national_service OR (c.geom IS NOT NULL AND ST_DWithin(c.geom, ${origin}, ${p(params.radiusKm * 1000)}::float8)))`,
    );
  }
  if (params.bbox) {
    const [w, s, e, n] = params.bbox;
    where.push(
      `(c.national_service OR (c.geom IS NOT NULL AND ST_Intersects(c.geom::geometry, ` +
        `ST_MakeEnvelope(${p(w)}::float8, ${p(s)}::float8, ${p(e)}::float8, ${p(n)}::float8, 4326))))`,
    );
  }

  const distance = hasPoint
    ? `CASE WHEN c.geom IS NOT NULL THEN ST_Distance(c.geom, ${origin}) END`
    : 'NULL::float8';
  const proximity = hasPoint
    ? `CASE
         WHEN f.distance_m IS NOT NULL THEN 3.0 / (1 + (f.distance_m / 1000.0) / ${PROXIMITY_HALF_LIFE_KM})
         -- A nationwide service is reachable from anywhere, so it sits where a
         -- moderately near branch would rather than below everything with a pin.
         WHEN f.national_service THEN 1.2
         ELSE 0
       END`
    : '0';

  const langParam = p(lang);
  const limitParam = p(limit);
  const offsetParam = p(offset);

  const sql = `
    WITH filtered AS (
      SELECT c.*,
        ${distance} AS distance_m,
        ${textRank} AS text_rank,
        ${trgm} AS trgm
      FROM cards c
      ${where.length ? `WHERE ${where.join('\n        AND ')}` : ''}
    ),
    ranked AS (
      SELECT f.*,
        -- Three additive terms on comparable scales, so the weights mean
        -- something: how well the words match, how substantial the service is,
        -- and how close it is.
        COALESCE(f.text_rank, 0) * 6
          + COALESCE(f.trgm, 0) * 2
          + ln(1 + f.score) * 0.5
          + ${proximity} AS rank
      FROM filtered f
    ),
    grouped AS (
      SELECT r.*,
        ${
          collapse
            ? `row_number() OVER (PARTITION BY r.collapse_key ORDER BY r.rank DESC, r.score DESC) AS dup_rank,
             count(*) OVER (PARTITION BY r.collapse_key) AS dup_count`
            : '1::bigint AS dup_rank, 1::bigint AS dup_count'
        }
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
      (SELECT json_agg(to_jsonb(page) - 'rank' ORDER BY page.rank DESC, page.score DESC, page.card_id)
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
         LIMIT ${limitParam} OFFSET ${offsetParam}
       ) page) AS cards,
      -- Facets describe the whole filtered set, not the page, so the counts
      -- still make sense on page four.
      (SELECT json_agg(b) FROM (
         SELECT node AS id, tn.name, count(*)::int AS count
         FROM visible v, unnest(v.response_ids_all) AS node
         LEFT JOIN taxonomy_names tn ON tn.node_id = node AND tn.lang = ${langParam}
         GROUP BY node, tn.name ORDER BY count(*) DESC LIMIT 40
       ) b) AS response_facets,
      (SELECT json_agg(b) FROM (
         SELECT node AS id, tn.name, count(*)::int AS count
         FROM visible v, unnest(v.situation_ids_all) AS node
         LEFT JOIN taxonomy_names tn ON tn.node_id = node AND tn.lang = ${langParam}
         GROUP BY node, tn.name ORDER BY count(*) DESC LIMIT 40
       ) b) AS situation_facets,
      (SELECT json_agg(b) FROM (
         SELECT v.city AS id, v.city AS name, count(*)::int AS count
         FROM visible v WHERE v.city IS NOT NULL
         GROUP BY v.city ORDER BY count(*) DESC LIMIT 30
       ) b) AS city_facets
  `;

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
