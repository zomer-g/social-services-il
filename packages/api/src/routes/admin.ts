import { Router, type NextFunction, type Request, type Response } from 'express';
import { query } from '@ssil/db';
import { clearFixtures, loadFixtures, loadTaxonomy } from '@ssil/ingest';
import { mintKey } from '../apikeys.js';
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

/**
 * Why a query matched what it matched.
 *
 * Search over Hebrew has several stages that can each quietly produce nothing —
 * normalisation, tsquery construction, the index match, the trigram rescue — and
 * from the outside they all look the same: no results. This shows each stage's
 * output so the failing one is obvious.
 */
adminRouter.get(
  '/explain',
  handle(async (req, res) => {
    const term = String(req.query['q'] ?? '');
    const { rows } = await query(
      `SELECT
         $1::text                                AS input,
         ssil_tokens($1)                         AS tokens,
         ssil_normalize($1)                      AS normalized,
         ssil_tsquery($1, true)::text            AS tsquery,
         (ssil_tsquery($1, true) IS NULL)        AS tsquery_is_null,
         (SELECT count(*)::int FROM cards WHERE search_doc @@ ssil_tsquery($1, true)) AS fts_matches,
         (SELECT count(*)::int FROM cards WHERE search_text % ssil_normalize($1))     AS trigram_matches,
         (SELECT count(*)::int FROM cards)       AS total_cards,
         current_setting('pg_trgm.similarity_threshold', true) AS trigram_threshold`,
      [term],
    );

    const sample = await query(
      `SELECT card_id, service_name, left(search_text, 160) AS search_text,
              ts_rank_cd(search_doc, ssil_tsquery($1, true), 32) AS text_rank,
              similarity(search_text, ssil_normalize($1)) AS trgm
         FROM cards
        ORDER BY text_rank DESC NULLS LAST
        LIMIT 5`,
      [term],
    );

    res.json({ ...rows[0], sample: sample.rows });
  }),
);

/**
 * Sources and their keys.
 *
 * A source is the unit of attribution and of trust: everything pushed with a
 * key attributed to it inherits its trust level, which decides whether a write
 * publishes straight away or waits for a person.
 */
adminRouter.get(
  '/sources',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT s.id, s.slug, s.name, s.kind, s.schedule, s.trust_level, s.enabled, s.last_run_at,
              (SELECT count(*)::int FROM services sv WHERE sv.source_id = s.id) AS services,
              (SELECT count(*)::int FROM api_keys k WHERE k.source_id = s.id AND k.revoked_at IS NULL) AS active_keys
         FROM sources s ORDER BY s.name`,
    );
    res.json({ sources: rows });
  }),
);

adminRouter.post(
  '/sources',
  handle(async (req, res) => {
    const body = req.body as {
      slug?: string; name?: string; kind?: string;
      trust_level?: number; schedule?: string; config?: Record<string, unknown>;
    };
    if (!body.slug || !body.name || !body.kind) {
      res.status(400).json({ error: 'bad_request', message: 'slug, name and kind are required' });
      return;
    }
    const { rows } = await query(
      `INSERT INTO sources (slug, name, kind, trust_level, schedule, config)
       VALUES ($1, $2, $3::ssil_source_kind, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, kind = EXCLUDED.kind, trust_level = EXCLUDED.trust_level,
         schedule = EXCLUDED.schedule, config = EXCLUDED.config, updated_at = now()
       RETURNING id, slug, name, kind, trust_level, enabled`,
      [body.slug, body.name, body.kind, body.trust_level ?? 50, body.schedule ?? null,
       JSON.stringify(body.config ?? {})],
    );
    res.status(201).json(rows[0]);
  }),
);

adminRouter.get(
  '/keys',
  handle(async (_req, res) => {
    // Only the prefix, never the key: it exists exactly once, in the response
    // to its own creation.
    const { rows } = await query(
      `SELECT k.id, k.name, k.key_prefix, k.scopes, s.slug AS source, k.last_used_at,
              k.revoked_at, k.created_at
         FROM api_keys k LEFT JOIN sources s ON s.id = k.source_id
        ORDER BY k.created_at DESC`,
    );
    res.json({ keys: rows });
  }),
);

adminRouter.post(
  '/keys',
  handle(async (req, res) => {
    const body = req.body as { name?: string; source_slug?: string; scopes?: string[] };
    if (!body.name) {
      res.status(400).json({ error: 'bad_request', message: 'name is required' });
      return;
    }

    let sourceId: string | null = null;
    if (body.source_slug) {
      const { rows } = await query<{ id: string }>('SELECT id FROM sources WHERE slug = $1', [body.source_slug]);
      if (!rows[0]) {
        res.status(400).json({ error: 'unknown_source', message: `No source with slug ${body.source_slug}` });
        return;
      }
      sourceId = rows[0].id;
    }

    const { key, hash, prefix } = mintKey();
    const { rows } = await query(
      `INSERT INTO api_keys (name, key_hash, key_prefix, scopes, source_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, key_prefix, scopes, created_at`,
      [body.name, hash, prefix, body.scopes ?? ['ingest:write'], sourceId],
    );

    res.status(201).json({
      ...rows[0],
      key,
      note: 'This is the only time the key is shown. Store it now.',
    });
  }),
);

adminRouter.delete(
  '/keys/:id',
  handle(async (req, res) => {
    const { rowCount } = await query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [req.params['id']],
    );
    res.status(rowCount ? 200 : 404).json({ revoked: (rowCount ?? 0) > 0 });
  }),
);

/** Everything waiting on a person. */
adminRouter.get(
  '/moderation',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT m.id, m.kind, m.entity_type, m.entity_id, m.submitted_by, m.status, m.created_at,
              s.slug AS source, m.payload->>'name' AS name
         FROM moderation_queue m
         LEFT JOIN sources s ON s.id = m.source_id
        WHERE m.status = 'pending'
        ORDER BY m.created_at DESC
        LIMIT 200`,
    );
    res.json({ pending: rows });
  }),
);

adminRouter.post(
  '/moderation/:id',
  handle(async (req, res) => {
    const decision = req.query['decision'] === 'reject' ? 'rejected' : 'accepted';
    const { rows } = await query<{ entity_id: string | null }>(
      `UPDATE moderation_queue
          SET status = $2, reviewed_at = now(), reviewed_by = 'admin-token',
              review_note = $3
        WHERE id = $1 AND status = 'pending'
        RETURNING entity_id`,
      [req.params['id'], decision, String(req.query['note'] ?? '')],
    );
    const entityId = rows[0]?.entity_id;
    if (!entityId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    if (decision === 'accepted') {
      await query(`UPDATE services SET status = 'published', updated_at = now() WHERE id = $1`, [entityId]);
      await query(
        `UPDATE branches SET status = 'published' WHERE id IN (
           SELECT branch_id FROM service_branches WHERE service_id = $1)`,
        [entityId],
      );
      await query(
        `UPDATE organizations SET status = 'published' WHERE id IN (
           SELECT organization_id FROM service_organizations WHERE service_id = $1)`,
        [entityId],
      );
      await query('SELECT rebuild_cards()');
      await query('SELECT refresh_taxonomy_counts()');
    }

    res.json({ id: req.params['id'], decision });
  }),
);

/**
 * Removes everything a source contributed.
 *
 * Needed when a feed turns out to be wrong at the root — a bad mapping that
 * created five thousand malformed records — where correcting row by row is
 * slower than re-importing. Deliberately explicit and admin-only; a source's own
 * key can archive its services but cannot erase them.
 */
adminRouter.post(
  '/purge-source',
  handle(async (req, res) => {
    const slug = String(req.query['slug'] ?? '');
    if (!slug) {
      res.status(400).json({ error: 'bad_request', message: 'slug is required' });
      return;
    }

    const { rows } = await query<{ id: string }>('SELECT id FROM sources WHERE slug = $1', [slug]);
    const sourceId = rows[0]?.id;
    if (!sourceId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const services = await query('DELETE FROM services WHERE source_id = $1', [sourceId]);
    const branches = await query('DELETE FROM branches WHERE source_id = $1', [sourceId]);
    const organizations = await query('DELETE FROM organizations WHERE source_id = $1', [sourceId]);

    res.json({
      source: slug,
      deleted: {
        services: services.rowCount ?? 0,
        branches: branches.rowCount ?? 0,
        organizations: organizations.rowCount ?? 0,
      },
    });
  }),
);
