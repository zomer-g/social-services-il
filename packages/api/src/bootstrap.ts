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

  await rebuildIfFlagged();
  await pruneSearchLog();
}

/**
 * Sweeps old search events.
 *
 * The log now holds the sentence somebody typed about their situation and the
 * answer they were given, which is worth keeping long enough to fix the corpus
 * and no longer. Run at boot rather than on a timer: this is a low-traffic
 * service that is redeployed regularly, and a cron container to delete a few
 * hundred rows would be more moving parts than the job is worth.
 */
async function pruneSearchLog(): Promise<void> {
  try {
    const { rows } = await query<{ prune_search_events: number }>('SELECT prune_search_events()');
    const removed = rows[0]?.prune_search_events ?? 0;
    if (removed > 0) console.log(`[info] pruned ${removed} expired search events`);
  } catch (err) {
    // Retention failing must not stop the server from starting.
    console.error('[warn] could not prune search events:', (err as Error).message);
  }
}

/**
 * Rebuilds the card table when a migration has invalidated it.
 *
 * Runs here rather than inside the migration because the rebuild can take
 * longer than the platform's 120-second health check, and a deploy that is
 * otherwise fine should not roll back over it. The server is already serving
 * the previous cards while this runs.
 */
async function rebuildIfFlagged(): Promise<void> {
  const { rows } = await query<{ value: string }>(
    `SELECT value FROM system_state WHERE key = 'cards_need_rebuild'`,
  );
  const reason = rows[0]?.value;
  if (!reason) return;

  console.log(`[info] rebuilding cards (${reason})`);
  const started = Date.now();
  const built = await query<{ rebuild_all: number }>('SELECT rebuild_all()');
  await query('SELECT refresh_taxonomy_counts()');
  await query(`DELETE FROM system_state WHERE key = 'cards_need_rebuild'`);
  console.log(
    `[info] rebuilt ${built.rows[0]?.rebuild_all ?? 0} cards in ${Date.now() - started}ms`,
  );
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
