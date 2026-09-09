import { query } from '@ssil/db';

/**
 * Recording what a search did.
 *
 * One function for all three search routes, because the value of the log is
 * that a failure on any of them looks the same in the admin. When each route
 * wrote its own INSERT the smart route recorded only its successes and the deep
 * route recorded nothing, so the searches most worth reading were exactly the
 * ones missing.
 *
 * Two rules hold everywhere it is called. It never throws and never blocks the
 * response — a search that worked must not fail because the analytics write
 * did. And it records no identifier: what was asked and what came back, never
 * who asked. That is why the failure paths below pass the query text but not
 * the address it came from, even though the rate limiter has one to hand.
 */

export type SearchKind = 'plain' | 'smart' | 'deep';

/**
 * How the search ended.
 *
 * The distinction that matters is between `empty` and the rest. `empty` is the
 * machinery working correctly over a corpus that has nothing — a content
 * problem, fixed by collecting more services. Everything after it is the search
 * itself breaking, which is ours to fix, and which the old result_count column
 * could not tell apart from a corpus gap.
 */
export type SearchOutcome =
  | 'ok'
  | 'empty'
  | 'error'
  | 'declined'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid';

export interface SearchEvent {
  kind: SearchKind;
  outcome: SearchOutcome;
  query?: string | null | undefined;
  responseIds?: string[] | undefined;
  situationIds?: string[] | undefined;
  city?: string | null | undefined;
  hasLocation?: boolean | undefined;
  lang?: string | undefined;
  resultCount?: number | undefined;
  cardIds?: string[] | undefined;
  answer?: string | null | undefined;
  toolsUsed?: string[] | undefined;
  sources?: string[] | undefined;
  unavailable?: unknown;
  error?: string | null | undefined;
  durationMs?: number | undefined;
}

/** Long enough to read in the admin, short enough not to store an essay. */
const MAX_QUERY = 500;
const MAX_ANSWER = 4000;
const MAX_ERROR = 500;
/** The page shows the cards a search produced; twenty is what the routes return. */
const MAX_CARD_IDS = 20;

export function recordSearch(event: SearchEvent): void {
  void query(
    `INSERT INTO search_events
       (kind, outcome, query, normalized, response_ids, situation_ids, city,
        has_location, lang, result_count, card_ids, answer, tools_used,
        sources, unavailable, error, duration_ms)
     VALUES ($1, $2, $3, ssil_normalize($3), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      event.kind,
      event.outcome,
      clip(event.query, MAX_QUERY),
      event.responseIds ?? [],
      event.situationIds ?? [],
      event.city ?? null,
      event.hasLocation ?? false,
      event.lang ?? 'he',
      event.resultCount ?? event.cardIds?.length ?? 0,
      (event.cardIds ?? []).slice(0, MAX_CARD_IDS),
      clip(event.answer, MAX_ANSWER),
      event.toolsUsed ?? [],
      event.sources ?? [],
      event.unavailable === undefined ? null : JSON.stringify(event.unavailable),
      clip(event.error, MAX_ERROR),
      event.durationMs ?? null,
    ],
  ).catch((err: Error) => {
    console.error('[warn] could not record search event:', err.message);
  });
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/** `ok` when something came back, `empty` when the corpus had nothing for it. */
export function outcomeFor(count: number): SearchOutcome {
  return count > 0 ? 'ok' : 'empty';
}
