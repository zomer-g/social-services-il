import { query } from './pool.js';

/**
 * Does this already exist here?
 *
 * The question a new record has to answer before it is written. It is asked by
 * the agreements pipeline — where the same service usually already exists,
 * having arrived earlier from another source — but nothing about it is specific
 * to agreements: any caller holding a service it is about to push can ask first.
 *
 * Three properties are load-bearing.
 *
 * It is deterministic. The same candidate against the same corpus gives the same
 * answer, with the same numbers, and a person reading a decision can reproduce
 * it. A model may write the candidate; it does not get to decide the identity of
 * a record in the corpus.
 *
 * Every component is reported, not just the total. "0.81" is not reviewable;
 * "the name matches at 0.91, it is the same organization, and they share a phone
 * number" is — and when the answer is wrong, the component that was wrong is
 * visible instead of having to be guessed at.
 *
 * A missing signal is missing, not zero. A candidate with no city, no tags and
 * no phone number should not be punished for it — that would push every thin
 * record towards "new" and quietly duplicate the corpus. Unknown components drop
 * out of the average, and the decision rule then asks separately for
 * corroboration before it will call anything a match.
 */

export interface MatchInput {
  name: string;
  /** Other names the same offering goes by. Each is tried; the best wins. */
  alternateNames?: string[] | undefined;
  organizationName?: string | undefined;
  /** The Israeli registration number, where the caller has one. Decisive. */
  organizationId?: string | undefined;
  city?: string | undefined;
  lat?: number | undefined;
  lon?: number | undefined;
  phoneNumbers?: string[] | undefined;
  urls?: string[] | undefined;
  /** Response taxonomy ids. Compared after expansion to ancestors. */
  responses?: string[] | undefined;
  nationalService?: boolean | undefined;
  limit?: number | undefined;
}

export interface MatchComponents {
  /** Similarity of the names, after Hebrew normalisation. */
  name: number | null;
  /** 1 when the registration numbers agree, otherwise name similarity. */
  organization: number | null;
  /** Jaccard overlap of the response tags, each expanded to its ancestors. */
  taxonomy: number | null;
  /** Same town, or how near the two points are. */
  geography: number | null;
  /** A shared phone number, or a shared web host. */
  contact: number | null;
}

export interface MatchCandidate {
  service_id: string;
  card_id: string;
  service_name: string;
  service_description: string | null;
  organization_id: string;
  organization_name: string;
  organization_kind: string | null;
  city: string | null;
  address: string | null;
  national_service: boolean;
  phone_numbers: string[];
  response_ids: string[];
  distance_m: number | null;
  score: number;
  components: MatchComponents;
  /** Why this scored as it did, in words, most telling first. */
  reasons: string[];
  updated_at: string;
  /** Links already recorded between this service and some source document. */
  existing_links: number;
}

export interface MatchResult {
  decision: 'link' | 'review' | 'new';
  /** Why the decision came out this way. Always at least one line. */
  rationale: string[];
  best: MatchCandidate | null;
  candidates: MatchCandidate[];
}

/**
 * What each signal is worth.
 *
 * The name carries most of it, because two records with the same name and
 * nothing else in common are usually the same service written down twice, and
 * two records with different names rarely are.
 *
 * Contact is weighted low despite being the most specific signal here — a shared
 * phone number is very often the organization's switchboard, which every service
 * it runs will list. It corroborates; it does not by itself identify. The
 * decision rule below is where it earns its keep.
 */
const WEIGHTS: Record<keyof MatchComponents, number> = {
  name: 0.45,
  organization: 0.25,
  taxonomy: 0.12,
  geography: 0.1,
  contact: 0.08,
};

/** A match confident enough to record without a person looking at it. */
const LINK_SCORE = 0.78;
/** …but never on the strength of the name alone, however well it scores. */
const LINK_NAME = 0.6;
const LINK_CORROBORATION = 0.75;
/** Below this there is nothing worth a person's time; the candidate is new. */
const REVIEW_SCORE = 0.45;
/**
 * Two candidates this close are not one answer. A chain running the same
 * programme in forty towns produces exactly this, and picking the higher of two
 * indistinguishable rows would attach the agreement to an arbitrary branch.
 */
const AMBIGUOUS_GAP = 0.04;

/** How many rows each recall path may contribute before scoring. */
const POOL_TEXT = 200;
const POOL_FUZZY = 100;
const POOL_ORG = 300;
const POOL_CONTACT = 200;

interface ScoredRow {
  card_id: string;
  service_id: string;
  organization_id: string;
  service_name: string;
  service_description: string | null;
  organization_name: string;
  organization_kind: string | null;
  city: string | null;
  address: string | null;
  national_service: boolean;
  phone_numbers: string[];
  response_ids: string[];
  updated_at: string;
  distance_m: number | null;
  existing_links: number;
  name_sim: number | null;
  org_sim: number | null;
  tax_sim: number | null;
  geo_sim: number | null;
  contact_sim: number | null;
}

export async function matchService(input: MatchInput): Promise<MatchResult> {
  const built = buildMatchQuery(input);
  if (!built) {
    return { decision: 'new', rationale: ['The candidate has no name to match on.'], best: null, candidates: [] };
  }
  const { rows } = await query<ScoredRow>(built.sql, built.args);
  return rank(rows, Math.min(Math.max(input.limit ?? 5, 1), 25));
}

/**
 * The statement, separated from running it so it can be read and asserted on
 * without a database. There are only a handful of distinct shapes and each one
 * describes its filters honestly to the planner; see the note in search.ts.
 */
export function buildMatchQuery(input: MatchInput): { sql: string; args: unknown[] } | null {
  const names = [input.name, ...(input.alternateNames ?? [])]
    .map((n) => n?.trim())
    .filter((n): n is string => !!n && n.length > 1)
    .slice(0, 4);
  if (names.length === 0) return null;

  const phones = (input.phoneNumbers ?? []).filter(Boolean).slice(0, 10);
  const urls = (input.urls ?? []).filter(Boolean).slice(0, 10);
  const responses = (input.responses ?? []).filter(Boolean).slice(0, 30);
  const hasPoint = typeof input.lat === 'number' && typeof input.lon === 'number';

  const args: unknown[] = [];
  const p = (value: unknown): string => {
    args.push(value);
    return `$${args.length}`;
  };

  const namesParam = p(names);
  const responsesParam = p(responses);
  const phonesParam = p(phones);
  const hostsParam = p(urls);
  const orgIdParam = p(input.organizationId ?? null);
  const orgNameParam = p(input.organizationName ?? null);
  const cityParam = p(input.city ?? null);
  const nationalParam = p(input.nationalService ?? false);
  const latParam = p(hasPoint ? input.lat : null);
  const lonParam = p(hasPoint ? input.lon : null);

  // Recall before ranking. Each path answers a different way of being the same
  // service — it says the same words, it says them misspelled, it is run by the
  // same body, it answers the same telephone — and a candidate only has to be
  // found by one of them to be scored by all of them.
  const paths: string[] = [];
  for (const name of names) {
    const term = p(name);
    paths.push(
      `SELECT card_id FROM cards
        WHERE search_doc @@ ssil_tsquery_any(${term}, false)
        ORDER BY ts_rank_cd(search_doc, ssil_tsquery_any(${term}, false), 32) DESC
        LIMIT ${POOL_TEXT}`,
    );
    paths.push(
      `SELECT card_id FROM cards
        WHERE ssil_normalize_plain(${term}) <% search_text
        ORDER BY word_similarity(ssil_normalize_plain(${term}), search_text) DESC
        LIMIT ${POOL_FUZZY}`,
    );
  }
  if (input.organizationId) {
    paths.push(`SELECT card_id FROM cards WHERE organization_id = ${orgIdParam} LIMIT ${POOL_ORG}`);
  }
  if (input.organizationName) {
    paths.push(
      `SELECT c.card_id FROM cards c
         JOIN organizations o ON o.id = c.organization_id
        WHERE o.name % ${orgNameParam}
        LIMIT ${POOL_ORG}`,
    );
  }
  if (phones.length) {
    paths.push(
      `SELECT card_id FROM cards
        WHERE EXISTS (SELECT 1 FROM unnest(phone_numbers) AS x(ph)
                       WHERE ssil_phone_key(x.ph) IN (SELECT k FROM phone_keys))
        LIMIT ${POOL_CONTACT}`,
    );
  }

  const origin = `ST_SetSRID(ST_MakePoint(${lonParam}::float8, ${latParam}::float8), 4326)::geography`;

  const sql = `
    WITH names AS (
      SELECT ssil_normalize_plain(n) AS n
        FROM unnest(${namesParam}::text[]) AS t(n)
       WHERE ssil_normalize_plain(n) <> ''
    ),
    -- Tags are compared after expansion to their ancestors, so "food pantry"
    -- against "food" reads as strong agreement rather than as a miss.
    tags AS (
      SELECT DISTINCT ancestor_id AS id
        FROM taxonomy_closure
       WHERE descendant_id = ANY(${responsesParam}::text[])
    ),
    phone_keys AS (
      SELECT DISTINCT ssil_phone_key(ph) AS k
        FROM unnest(${phonesParam}::text[]) AS t(ph)
       WHERE ssil_phone_key(ph) IS NOT NULL
    ),
    hosts AS (
      SELECT DISTINCT ssil_url_host(u) AS h
        FROM unnest(${hostsParam}::text[]) AS t(u)
       WHERE ssil_url_host(u) IS NOT NULL
    ),
    pool AS (
      -- Each branch is parenthesised: an unparenthesised ORDER BY or LIMIT
      -- inside a UNION binds to the whole union, not to the branch, and the
      -- per-path ceilings are the only thing keeping this bounded.
      ${paths.map((path) => `(${path})`).join('\n      UNION\n      ')}
    )
    SELECT
      c.card_id, c.service_id, c.organization_id,
      c.service_name, c.service_description,
      c.organization_name, c.organization_kind,
      c.city, c.address, c.national_service,
      c.phone_numbers, c.response_ids, c.updated_at,
      CASE WHEN ${latParam}::float8 IS NOT NULL AND c.geom IS NOT NULL
           THEN round(ST_Distance(c.geom, ${origin}))::int END AS distance_m,
      (SELECT count(*)::int FROM service_links sl
        WHERE sl.service_id = c.service_id AND sl.status = 'confirmed') AS existing_links,

      (SELECT max(GREATEST(
                similarity(n.n, ssil_normalize_plain(c.service_name)),
                word_similarity(n.n, ssil_normalize_plain(c.service_name))))
         FROM names n) AS name_sim,

      CASE
        WHEN ${orgIdParam}::text IS NOT NULL AND c.organization_id = ${orgIdParam}::text THEN 1.0
        WHEN ${orgNameParam}::text IS NOT NULL AND ssil_normalize_plain(${orgNameParam}) <> ''
          THEN GREATEST(
                 similarity(ssil_normalize_plain(${orgNameParam}), ssil_normalize_plain(c.organization_name)),
                 word_similarity(ssil_normalize_plain(${orgNameParam}), ssil_normalize_plain(c.organization_name)))
        ELSE NULL
      END AS org_sim,

      CASE WHEN (SELECT count(*) FROM tags) = 0 THEN NULL ELSE
        (SELECT count(*)::float8 FROM (
           SELECT r FROM unnest(c.response_ids_all) AS u(r)
           INTERSECT SELECT id FROM tags) i)
        / NULLIF((SELECT count(*)::float8 FROM (
           SELECT r FROM unnest(c.response_ids_all) AS u(r)
           UNION SELECT id FROM tags) v), 0)
      END AS tax_sim,

      CASE
        WHEN ${nationalParam}::boolean AND c.national_service THEN 1.0
        WHEN ${cityParam}::text IS NOT NULL AND c.city IS NOT NULL
             AND c.city = COALESCE(ssil_resolve_city(${cityParam}), ${cityParam}) THEN 1.0
        WHEN ${latParam}::float8 IS NOT NULL AND c.geom IS NOT NULL
             THEN 1.0 / (1.0 + (ST_Distance(c.geom, ${origin}) / 1000.0) / 5.0)
        -- A nationwide service is delivered in the candidate's town too, so
        -- its lack of a pin there says nothing either way.
        WHEN c.national_service THEN NULL
        WHEN ${cityParam}::text IS NOT NULL AND c.city IS NOT NULL THEN 0.0
        ELSE NULL
      END AS geo_sim,

      CASE
        WHEN EXISTS (SELECT 1 FROM unnest(c.phone_numbers) AS x(ph)
                      WHERE ssil_phone_key(x.ph) IN (SELECT k FROM phone_keys)) THEN 1.0
        -- Guarded on the type: jsonb_array_elements throws on anything that is
        -- not an array, and one malformed row would take the whole match down
        -- rather than just itself.
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(s.urls) = 'array' THEN s.urls ELSE '[]'::jsonb END) AS u
                      WHERE ssil_url_host(u->>'href') IN (SELECT h FROM hosts)) THEN 0.7
        WHEN (SELECT count(*) FROM phone_keys) = 0 AND (SELECT count(*) FROM hosts) = 0 THEN NULL
        ELSE 0.0
      END AS contact_sim

    FROM cards c
    JOIN services s ON s.id = c.service_id
    WHERE c.card_id IN (SELECT card_id FROM pool)
  `;

  return { sql, args };
}

function rank(rows: ScoredRow[], limit: number): MatchResult {
  // One row per service, not per card: the question is whether this service
  // exists, and a body running it in ninety branches would otherwise fill the
  // whole answer with ninety versions of the same yes.
  const best = new Map<string, MatchCandidate>();
  for (const row of rows) {
    const candidate = toCandidate(row);
    const existing = best.get(row.service_id);
    if (!existing || candidate.score > existing.score) best.set(row.service_id, candidate);
  }

  const candidates = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return decide(candidates);
}

function toCandidate(row: ScoredRow): MatchCandidate {
  const components: MatchComponents = {
    name: row.name_sim,
    organization: row.org_sim,
    taxonomy: row.tax_sim,
    geography: row.geo_sim,
    contact: row.contact_sim,
  };

  // The average is over the signals we actually have. Scoring a missing city as
  // zero would make a thin record look like a bad match rather than an
  // unverified one, and the two want opposite treatment.
  let weighted = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS) as [keyof MatchComponents, number][]) {
    const value = components[key];
    if (value === null || value === undefined) continue;
    weighted += weight * value;
    total += weight;
  }
  const score = total > 0 ? weighted / total : 0;

  return {
    service_id: row.service_id,
    card_id: row.card_id,
    service_name: row.service_name,
    service_description: row.service_description,
    organization_id: row.organization_id,
    organization_name: row.organization_name,
    organization_kind: row.organization_kind,
    city: row.city,
    address: row.address,
    national_service: row.national_service,
    phone_numbers: row.phone_numbers,
    response_ids: row.response_ids,
    distance_m: row.distance_m,
    score: round(score) ?? 0,
    components: {
      name: round(components.name),
      organization: round(components.organization),
      taxonomy: round(components.taxonomy),
      geography: round(components.geography),
      contact: round(components.contact),
    },
    reasons: reasonsFor(components, row),
    updated_at: row.updated_at,
    existing_links: row.existing_links,
  };
}

function reasonsFor(c: MatchComponents, row: ScoredRow): string[] {
  const reasons: string[] = [];
  if (c.contact === 1) reasons.push('Shares a phone number.');
  else if (c.contact === 0.7) reasons.push('Points at the same website.');
  if (c.organization === 1) reasons.push('Same organization id.');
  else if ((c.organization ?? 0) >= 0.75) reasons.push(`Organization names agree (${round(c.organization)}).`);
  else if (c.organization !== null && c.organization < 0.35) reasons.push(`Run by a different body (${row.organization_name}).`);
  if (c.name !== null) reasons.push(`Name similarity ${round(c.name)}.`);
  if (c.geography === 1) reasons.push(row.national_service ? 'Both are nationwide.' : `Same town (${row.city}).`);
  else if (row.distance_m != null) reasons.push(`${(row.distance_m / 1000).toFixed(1)} km away.`);
  else if (c.geography === 0) reasons.push(`A different town (${row.city}).`);
  if ((c.taxonomy ?? 0) >= 0.5) reasons.push('Tagged with the same categories.');
  else if (c.taxonomy !== null && c.taxonomy < 0.15) reasons.push('Tagged under quite different categories.');
  return reasons;
}

function decide(candidates: MatchCandidate[]): MatchResult {
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;

  if (!best || best.score < REVIEW_SCORE) {
    return {
      decision: 'new',
      rationale: best
        ? [`The closest thing in the corpus scores ${best.score}, below the ${REVIEW_SCORE} worth reviewing.`]
        : ['Nothing in the corpus resembles this service.'],
      best,
      candidates,
    };
  }

  const rationale: string[] = [];
  const corroborated =
    (best.components.organization ?? 0) >= LINK_CORROBORATION || best.components.contact === 1;

  if (best.score < LINK_SCORE) {
    rationale.push(`Best match scores ${best.score}, under the ${LINK_SCORE} needed to link without a person.`);
  }
  if ((best.components.name ?? 0) < LINK_NAME) {
    rationale.push(`The names only agree at ${best.components.name ?? 0}.`);
  }
  if (!corroborated) {
    rationale.push('Nothing beyond the name corroborates it: not the same organization, no shared phone number.');
  }
  if (runnerUp && best.score - runnerUp.score < AMBIGUOUS_GAP) {
    rationale.push(
      `Two candidates are indistinguishable (${best.score} and ${runnerUp.score}) — ${best.service_name} and ${runnerUp.service_name}.`,
    );
  }

  if (rationale.length === 0) {
    return {
      decision: 'link',
      rationale: [`${best.service_name} matches at ${best.score}. ${best.reasons.join(' ')}`],
      best,
      candidates,
    };
  }

  return { decision: 'review', rationale, best, candidates };
}

function round(value: number | null): number | null {
  return value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
}
