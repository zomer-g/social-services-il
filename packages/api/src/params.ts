/**
 * Query-string parsing.
 *
 * Hand-rolled rather than schema-driven, because the rules here are mostly
 * about coercion and clamping rather than shape, and every one of them wants a
 * specific error message. A caller who sends `lat` without `lon` should be told
 * that, not handed a generic validation dump.
 */

export class BadRequest extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'BadRequest';
  }
}

type Q = Record<string, unknown>;

export function str(q: Q, name: string): string | undefined {
  const raw = q[name];
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return str({ [name]: raw[0] }, name);
  const value = String(raw).trim();
  return value.length ? value : undefined;
}

/**
 * Repeatable parameters, accepted both as `?x=a&x=b` and as `?x=a,b`. Callers
 * reach for both and neither is wrong.
 */
export function list(q: Q, name: string): string[] | undefined {
  const raw = q[name];
  if (raw === undefined || raw === null) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

export function num(q: Q, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = str(q, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new BadRequest(`${name} must be a number`, name);
  if (opts.min !== undefined && value < opts.min) {
    throw new BadRequest(`${name} must be at least ${opts.min}`, name);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new BadRequest(`${name} must be at most ${opts.max}`, name);
  }
  return value;
}

export function int(q: Q, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const value = num(q, name, opts);
  return value === undefined ? undefined : Math.trunc(value);
}

export function bool(q: Q, name: string): boolean | undefined {
  const raw = str(q, name);
  if (raw === undefined) return undefined;
  if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
  throw new BadRequest(`${name} must be true or false`, name);
}

export function oneOf<T extends string>(q: Q, name: string, allowed: readonly T[]): T | undefined {
  const raw = str(q, name);
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new BadRequest(`${name} must be one of: ${allowed.join(', ')}`, name);
  }
  return raw as T;
}

/** `?bbox=west,south,east,north`, in degrees. */
export function bbox(q: Q, name = 'bbox'): [number, number, number, number] | undefined {
  const raw = str(q, name);
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new BadRequest(`${name} must be four numbers: west,south,east,north`, name);
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west >= east || south >= north) {
    throw new BadRequest(`${name} must be ordered west,south,east,north`, name);
  }
  return [west, south, east, north];
}

/**
 * A coordinate pair. Both or neither: a lone latitude is a caller bug that
 * would otherwise be silently ignored and produce unranked results.
 */
export function point(q: Q): { lat: number; lon: number } | undefined {
  const lat = num(q, 'lat', { min: -90, max: 90 });
  const lon = num(q, 'lon', { min: -180, max: 180 });
  if (lat === undefined && lon === undefined) return undefined;
  if (lat === undefined || lon === undefined) {
    throw new BadRequest('lat and lon must be given together');
  }
  return { lat, lon };
}
