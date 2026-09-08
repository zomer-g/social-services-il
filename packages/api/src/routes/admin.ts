import { Router, type NextFunction, type Request, type Response } from 'express';
import { query } from '@ssil/db';
import { clearFixtures, loadFixtures, loadTaxonomy } from '@ssil/ingest';
import { config } from '../config.js';

/**
 * Administrative operations.
 *
 * Guarded for now by a single bearer token in ADMIN_TOKEN. Google sign-in with
 * invitations and per-role permissions replaces this in the admin phase; until
 * then the token is the whole of the authorisation model, and every route here
 * changes published data, so the guard refuses outright when no token is set
 * rather than defaulting to open.
 */
export const adminRouter: Router = Router();

function requireToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env['ADMIN_TOKEN'];
  if (!expected) {
    res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_TOKEN is not configured' });
    return;
  }
  const header = req.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Length-independent comparison is not worth the ceremony here, but a plain
  // equality check on a fixed-length token is: both sides are constants.
  if (presented.length !== expected.length || presented !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

adminRouter.use(requireToken);

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      console.error('[error] admin handler:', err.stack ?? err.message);
      res.status(500).json({ error: 'internal_error', message: err.message });
    });
  };
}

/**
 * Rebuilds the card table from the entity tables. This is what "publish" means:
 * edits to services, branches and tags are invisible to the public API until a
 * rebuild runs.
 */
adminRouter.post(
  '/rebuild',
  handle(async (_req, res) => {
    const started = Date.now();
    const { rows } = await query<{ rebuild_cards: number }>('SELECT rebuild_cards()');
    await query('SELECT refresh_taxonomy_counts()');

    const rejections = await query<{ reason: string; n: number }>(
      'SELECT reason, count(*)::int AS n FROM card_rejections GROUP BY reason ORDER BY n DESC',
    );

    res.json({
      cards: rows[0]?.rebuild_cards ?? 0,
      rejected: Object.fromEntries(rejections.rows.map((r) => [r.reason, r.n])),
      duration_ms: Date.now() - started,
    });
  }),
);

/** Re-reads the vendored taxonomy file, picking up an upstream update. */
adminRouter.post(
  '/taxonomy/sync',
  handle(async (_req, res) => {
    const result = await loadTaxonomy();
    await query('SELECT refresh_taxonomy_counts()');
    res.json(result);
  }),
);

/**
 * Loads or clears the development fixtures. Refuses on a database that already
 * holds real data, so this cannot be aimed at production by accident.
 */
adminRouter.post(
  '/fixtures',
  handle(async (req, res) => {
    const clear = req.query['clear'] === 'true';
    if (clear) {
      await clearFixtures();
      await query('SELECT rebuild_cards()');
      await query('SELECT refresh_taxonomy_counts()');
      res.json({ cleared: true });
      return;
    }

    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM services
        WHERE source_id IS DISTINCT FROM (SELECT id FROM sources WHERE slug = 'fixtures')`,
    );
    if ((rows[0]?.n ?? 0) > 0 && req.query['force'] !== 'true') {
      res.status(409).json({
        error: 'corpus_not_empty',
        message: `${rows[0]?.n} services from real sources are present; pass force=true only if you mean it`,
      });
      return;
    }

    const result = await loadFixtures();
    const built = await query<{ rebuild_cards: number }>('SELECT rebuild_cards()');
    await query('SELECT refresh_taxonomy_counts()');
    res.json({ ...result, cards: built.rows[0]?.rebuild_cards ?? 0 });
  }),
);

/** Why rows were left out of the last rebuild. */
adminRouter.get(
  '/rejections',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT r.service_id, s.name AS service_name, r.branch_id, r.reason, r.detail, r.at
         FROM card_rejections r
         LEFT JOIN services s ON s.id = r.service_id
        ORDER BY r.reason, s.name
        LIMIT 500`,
    );
    res.json({ rejections: rows });
  }),
);

/**
 * Searches that returned nothing. The most direct evidence of what the corpus
 * is missing, which is a content problem rather than a code one.
 */
adminRouter.get(
  '/gaps',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT normalized, count(*)::int AS searches, max(at) AS last_seen,
              (array_agg(query ORDER BY at DESC))[1] AS example
         FROM search_events
        WHERE result_count = 0 AND normalized IS NOT NULL AND normalized <> ''
        GROUP BY normalized
        ORDER BY count(*) DESC, max(at) DESC
        LIMIT 100`,
    );
    res.json({ gaps: rows });
  }),
);

adminRouter.get(
  '/config',
  handle(async (_req, res) => {
    res.json({
      env: config.env,
      hasAnthropicKey: config.anthropicApiKey.length > 0,
      version: process.env['XHOST_SHA'] ?? 'dev',
    });
  }),
);
