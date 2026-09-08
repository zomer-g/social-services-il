/** Canonical domain types, shared by the API, the ingest pipeline and both SPAs. */

export type Lang = 'he' | 'ar' | 'ru' | 'en';
export const LANGS: readonly Lang[] = ['he', 'ar', 'ru', 'en'] as const;
export const DEFAULT_LANG: Lang = 'he';
/** Languages that render right-to-left. */
export const RTL_LANGS: ReadonlySet<Lang> = new Set<Lang>(['he', 'ar']);

/** The two taxonomy axes we use. `place` exists upstream but drives nothing here. */
export type Axis = 'response' | 'situation';

/**
 * Publication state. Only `published` rows reach the public API; everything
 * else is visible to the admin alone.
 */
export type Status = 'draft' | 'review' | 'published' | 'archived';

/**
 * Where a taxonomy tag came from. This is the column that decides conflicts:
 * a `manual` tag always wins, and `llm` never reaches the public site until a
 * human promotes it to `manual`.
 */
export type TagOrigin = 'source' | 'rule' | 'llm' | 'manual';

export interface Url {
  href: string;
  title?: string | null;
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  shortName?: string | null;
  /** e.g. עמותה, משרד ממשלתי, רשות מקומית, תאגיד סטטוטורי. Feeds ranking. */
  kind?: string | null;
  purpose?: string | null;
  description?: string | null;
  urls: Url[];
  phoneNumbers: string[];
  emailAddress?: string | null;
  status: Status;
  sourceId?: string | null;
  updatedAt: string;
}

export interface Branch {
  id: string;
  organizationId: string;
  name?: string | null;
  operatingUnit?: string | null;
  description?: string | null;
  address?: string | null;
  addressDetails?: string | null;
  city?: string | null;
  /** [lon, lat] — null for national services, which have no point at all. */
  geometry?: [number, number] | null;
  locationAccurate: boolean;
  urls: Url[];
  phoneNumbers: string[];
  emailAddress?: string | null;
  status: Status;
  updatedAt: string;
}

export interface Service {
  id: string;
  name: string;
  description?: string | null;
  details?: string | null;
  paymentRequired: boolean;
  paymentDetails?: string | null;
  urls: Url[];
  phoneNumbers: string[];
  emailAddress?: string | null;
  /** Free-text note about the programme this service implements. */
  implements?: string | null;
  /** Human-readable provenance strings shown on the card. */
  dataSources: string[];
  /** Editorial thumb on the scale; enters the score as a power of ten. */
  boost: number;
  status: Status;
  updatedAt: string;
}

export interface TaxonomyNode {
  /** Hierarchical colon-delimited slug, e.g. `human_services:food:soup_kitchen`. */
  id: string;
  axis: Axis;
  parentId: string | null;
  depth: number;
  names: Partial<Record<Lang, string>>;
  descriptions: Partial<Record<Lang, string>>;
  synonyms: Partial<Record<Lang, string[]>>;
  active: boolean;
}

/**
 * The denormalised service × branch row that the public site renders.
 * `cardId` is a stable hash of (serviceId, branchId).
 */
export interface Card {
  cardId: string;
  serviceId: string;
  branchId: string | null;
  organizationId: string;
  serviceName: string;
  serviceDescription?: string | null;
  organizationName: string;
  organizationShortName?: string | null;
  organizationKind?: string | null;
  branchName?: string | null;
  address?: string | null;
  city?: string | null;
  geometry?: [number, number] | null;
  /** True for services with no physical point, delivered anywhere in Israel. */
  nationalService: boolean;
  phoneNumbers: string[];
  responses: TaxonomyRef[];
  situations: TaxonomyRef[];
  score: number;
  /** Metres from the query point; present only on location-aware searches. */
  distanceM?: number | null;
  updatedAt: string;
}

export interface TaxonomyRef {
  id: string;
  name: string;
}
