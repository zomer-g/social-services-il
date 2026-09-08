/** Typed client for the public API. */

export interface Card {
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
  also_offered_by: number;
  updated_at: string;
}

export interface Facet {
  id: string;
  name: string | null;
  count: number;
}

export interface SearchResponse {
  total: number;
  cards: Card[];
  facets: { responses: Facet[]; situations: Facet[]; cities: Facet[] };
}

export interface TaxonomyRef {
  id: string;
  name: string | null;
}

export interface CardDetail extends Card {
  service_details: string | null;
  payment_required: boolean;
  payment_details: string | null;
  service_urls: { href: string; title?: string }[];
  service_email: string | null;
  organization_purpose: string | null;
  organization_description: string | null;
  organization_urls: { href: string; title?: string }[];
  organization_branch_count: number;
  address_details: string | null;
  responses: TaxonomyRef[] | null;
  situations: TaxonomyRef[] | null;
  also_at_this_branch: { card_id: string; service_name: string; service_description: string | null }[] | null;
}

export interface SearchQuery {
  q?: string;
  response?: string[];
  situation?: string[];
  city?: string;
  lat?: number;
  lon?: number;
  radiusKm?: number;
  nationalService?: 'only' | 'exclude';
  limit?: number;
  offset?: number;
  lang?: string;
}

function toParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  for (const id of query.response ?? []) params.append('response', id);
  for (const id of query.situation ?? []) params.append('situation', id);
  if (query.city) params.set('city', query.city);
  if (query.lat !== undefined && query.lon !== undefined) {
    params.set('lat', String(query.lat));
    params.set('lon', String(query.lon));
  }
  if (query.radiusKm !== undefined) params.set('radius_km', String(query.radiusKm));
  if (query.nationalService) params.set('national_service', query.nationalService);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  if (query.lang) params.set('lang', query.lang);
  return params;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
  return json<SearchResponse>(`/api/v1/search?${toParams(query)}`, { signal });
}

export function getCard(cardId: string, lang: string): Promise<CardDetail> {
  return json<CardDetail>(`/api/v1/cards/${encodeURIComponent(cardId)}?lang=${lang}`);
}

export interface Suggestion {
  id: string;
  axis: 'response' | 'situation';
  name: string;
  card_count: number;
}

export function autocomplete(
  term: string,
  lang: string,
  signal?: AbortSignal,
): Promise<{ taxonomy: Suggestion[]; services: { card_id: string; service_name: string; organization_name: string; city: string | null }[] }> {
  return json(`/api/v1/autocomplete?q=${encodeURIComponent(term)}&lang=${lang}`, { signal });
}

export function reportError(payload: {
  card_id: string;
  message: string;
  contact?: string;
}): Promise<{ ok: boolean }> {
  return json('/api/v1/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
