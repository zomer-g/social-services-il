import { migrate, query } from '@ssil/db';
import { loadTaxonomy, taxonomyIsEmpty } from '@ssil/ingest';
import { hasDatabase } from './config.js';

/**
 * Work that has to happen before the server is useful, but that must not stop
 * it from answering the health probe. Migrations run in launch.sh, ahead of
 * this; what is left is seeding data the app cannot function without.
 */
export async function bootstrap(): Promise<void> {
  if (!hasDatabase()) {
    console.log('[warn] DATABASE_URL is not set; running without a database');
    return;
  }

  // launch.sh already migrated. Calling again is cheap and idempotent, and
  // covers running the server directly in development.
  await migrate();

  if (await taxonomyIsEmpty()) {
    console.log('[info] taxonomy is empty, loading the vendored openeligibility tree');
    const { nodes, names } = await loadTaxonomy();
    console.log(`[info] taxonomy loaded: ${nodes} nodes, ${names} names`);
  }
}

/** Row counts for the main tables, for the health endpoint and the admin. */
export async function corpusCounts(): Promise<Record<string, number>> {
  const { rows } = await query<Record<string, number>>(`
    SELECT
      (SELECT count(*) FROM taxonomy_nodes WHERE active)::int AS taxonomy_nodes,
      (SELECT count(*) FROM organizations)::int              AS organizations,
      (SELECT count(*) FROM branches)::int                   AS branches,
      (SELECT count(*) FROM services)::int                   AS services,
      (SELECT count(*) FROM cards)::int                      AS cards,
      (SELECT count(*) FROM card_rejections)::int            AS card_rejections
  `);
  return rows[0] ?? {};
}
