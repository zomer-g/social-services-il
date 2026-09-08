import { createHash } from 'node:crypto';

/**
 * Card ids are an 8-hex-char hash of the service/branch pair. The upstream
 * system uses the same width and the same inputs, so ids minted here line up
 * with the ones already published under /p/card/c/<id> — which is what lets us
 * keep inbound links and search rankings alive after the migration.
 */
export function cardId(serviceId: string, branchId: string | null): string {
  return createHash('sha256')
    .update(`${serviceId}:${branchId ?? ''}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Stable id for a record arriving from an external source. Keying on
 * (source, externalId) rather than on content is what makes re-ingestion
 * idempotent: the same upstream row always lands on the same entity.
 */
export function externalKey(sourceSlug: string, externalId: string): string {
  return `${sourceSlug}:${externalId}`;
}

/** Content fingerprint used to skip work when an upstream row has not changed. */
export function contentHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** JSON.stringify with sorted keys, so hashes do not depend on key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
