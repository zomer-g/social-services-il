/**
 * Ingestion: source connectors, the scheduler and the importers.
 *
 * The scheduler runs in-process inside the API container rather than as its own
 * channel. Each channel on the host is provisioned with its own Postgres, so a
 * separate worker channel would connect to an empty database. A Postgres
 * advisory lock keeps a restart or a rolling deploy from running a job twice.
 */
export const INGEST_LOCK_KEY = 8_421_338;

export type SourceKind =
  | 'http_json'
  | 'csv_upload'
  | 'google_sheet'
  | 'ckan'
  | 'guidestar'
  | 'over'
  | 'webhook'
  | 'manual';

export interface SourceDefinition {
  slug: string;
  name: string;
  kind: SourceKind;
  config: Record<string, unknown>;
  /** Cron expression; null means the source is only pushed to, never pulled. */
  schedule: string | null;
  /**
   * 0-100. Above the auto-publish threshold a source writes straight to
   * `published`; below it, everything lands in the moderation queue.
   */
  trustLevel: number;
  enabled: boolean;
}

export const AUTO_PUBLISH_TRUST_THRESHOLD = 70;

export { loadTaxonomy, taxonomyIsEmpty, flattenTaxonomy } from './taxonomy.js';
export { loadFixtures, clearFixtures, fixtureCardIds } from './fixtures.js';
