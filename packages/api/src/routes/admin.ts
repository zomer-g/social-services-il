import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { query, transaction } from '@ssil/db';
import { clearFixtures, loadFixtures, loadTaxonomy } from '@ssil/ingest';
import { mintKey } from '../apikeys.js';
import { baseUrlOf, listServers, testServer } from '../mcpclient.js';
import { requireRole } from '../auth.js';
import { config } from '../config.js';

/**
 * Administrative operations.
 *
 * Guarded by requireRole, which accepts either a signed-in user with a
 * sufficient role or the bootstrap token in ADMIN_TOKEN — the token being how
 * the first administrator gets invited and how automated checks run.
 */
export const adminRouter: Router = Router();

adminRouter.use(requireRole('editor'));

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
        -- outcome, not result_count: a search that errored also returned no
        -- rows, and counting it here would send someone to collect services
        -- for a need the corpus may already cover.
        WHERE outcome = 'empty' AND normalized IS NOT NULL AND normalized <> ''
        GROUP BY normalized
        ORDER BY count(*) DESC, max(at) DESC
        LIMIT 100`,
    );
    res.json({ gaps: rows });
  }),
);

/**
 * Every search, with what it produced.
 *
 * The gaps list above answers "what is the corpus missing", which is a content
 * question. This answers a different one: did the search itself work. A smart
 * search that threw, one the model declined, one that ran while a source was
 * down — from the outside all of those look exactly like a search over a corpus
 * that had nothing, and only this list can tell them apart.
 *
 * `failed=true` is the working default for that job: it hides the searches that
 * returned results and leaves the ones somebody has to look at.
 */
adminRouter.get(
  '/searches',
  handle(async (req, res) => {
    const kinds = ['plain', 'smart', 'deep'];
    const outcomes = ['ok', 'empty', 'error', 'declined', 'rate_limited', 'unavailable', 'invalid'];

    const kind = kinds.includes(String(req.query['kind'] ?? '')) ? String(req.query['kind']) : null;
    const outcome = outcomes.includes(String(req.query['outcome'] ?? ''))
      ? String(req.query['outcome'])
      : null;
    // Anything that is not a plain success. Kept as one filter rather than
    // asking the reader to select six outcomes by hand.
    const failedOnly = req.query['failed'] === 'true';
    const term = String(req.query['q'] ?? '').trim();
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100), 1), 500);
    const offset = Math.max(Number(req.query['offset'] ?? 0), 0);

    const { rows } = await query(
      `SELECT id, at, kind, outcome, query, city, lang, has_location,
              result_count, duration_ms, error,
              cardinality(card_ids) AS cards_returned,
              response_ids, situation_ids, tools_used, sources,
              left(answer, 200) AS answer_preview,
              (answer IS NOT NULL) AS has_answer
         FROM search_events
        WHERE ($1::text IS NULL OR kind = $1)
          AND ($2::text IS NULL OR outcome = $2)
          AND (NOT $3::boolean OR outcome <> 'ok')
          -- strpos rather than ILIKE so that a % or _ someone typed is searched
          -- for rather than silently treated as a wildcard. The second arm
          -- catches the Hebrew forms — prefixes, final letters — that only
          -- match after normalisation.
          AND ($4::text = ''
               OR strpos(lower(query), lower($4)) > 0
               OR strpos(normalized, ssil_normalize($4)) > 0)
        ORDER BY at DESC
        LIMIT $5 OFFSET $6`,
      [kind, outcome, failedOnly, term, limit, offset],
    );

    // Counts over the whole window rather than the page, so the tabs can say
    // how many failures there are without paging to the end to find out.
    const totals = await query(
      `SELECT outcome, kind, count(*)::int AS n
         FROM search_events
        WHERE at > now() - interval '30 days'
        GROUP BY outcome, kind`,
    );

    res.json({ searches: rows, totals: totals.rows, limit, offset });
  }),
);

/**
 * One search, in full.
 *
 * The card ids are resolved back through the card table rather than replayed
 * from a stored copy, which means a card that has since been deleted shows as
 * missing instead of as a row that still exists. That difference is the point:
 * "this search returned four services and three of them are gone" is a finding.
 */
adminRouter.get(
  '/searches/:id',
  handle(async (req, res) => {
    const id = Number(req.params['id']);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(400).json({ error: 'bad_request', message: 'id must be a positive integer' });
      return;
    }
    const { rows } = await query(`SELECT * FROM search_events WHERE id = $1`, [id]);
    const event = rows[0] as Record<string, unknown> | undefined;
    if (!event) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const cardIds = (event['card_ids'] as string[] | null) ?? [];
    const cards = cardIds.length
      ? (
          await query(
            `SELECT o.id AS card_id, c.service_name, c.organization_name, c.city,
                    (c.card_id IS NOT NULL) AS still_present
               FROM unnest($1::text[]) WITH ORDINALITY AS o(id, ord)
               LEFT JOIN cards c ON c.card_id = o.id
              ORDER BY o.ord`,
            [cardIds],
          )
        ).rows
      : [];

    // Category ids are opaque strings; the person reading this thinks in names.
    const nodeIds = [
      ...((event['response_ids'] as string[] | null) ?? []),
      ...((event['situation_ids'] as string[] | null) ?? []),
    ];
    const names = nodeIds.length
      ? (
          await query<{ node_id: string; name: string }>(
            `SELECT node_id, name FROM taxonomy_names
              WHERE node_id = ANY($1::text[]) AND lang = 'he'`,
            [nodeIds],
          )
        ).rows
      : [];

    // The same phrase, however it was searched. A term that fails on the smart
    // route and works on the plain one is a routing bug, not a missing service,
    // and there is no way to see that from a single row.
    const related = await query(
      `SELECT id, at, kind, outcome, result_count
         FROM search_events
        WHERE normalized IS NOT NULL AND normalized <> ''
          AND normalized = $2 AND id <> $1
        ORDER BY at DESC LIMIT 20`,
      [id, event['normalized'] ?? ''],
    );

    res.json({
      search: event,
      cards,
      names: Object.fromEntries(names.map((n) => [n.node_id, n.name])),
      related: related.rows,
    });
  }),
);

adminRouter.get(
  '/config',
  handle(async (_req, res) => {
    // Counts and flags, never the values: this endpoint exists to answer "is it
    // configured", and printing an allowlist of who can administer the site
    // would be a small gift to anyone who got this far.
    const allowlisted = (process.env['ADMIN_EMAILS'] ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean).length;

    res.json({
      env: config.env,
      hasAnthropicKey: config.anthropicApiKey.length > 0,
      adminEmailsConfigured: allowlisted,
      signInProvider: 'google (platform)',
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
         ssil_normalize_plain($1)                                                     AS normalized_plain,
         (SELECT count(*)::int FROM cards WHERE ssil_normalize_plain($1) <% search_text) AS word_trigram_matches,
         (SELECT count(*)::int FROM cards)       AS total_cards,
         current_setting('pg_trgm.similarity_threshold', true) AS trigram_threshold`,
      [term],
    );

    const sample = await query(
      `SELECT card_id, service_name, left(search_text, 160) AS search_text,
              ts_rank_cd(search_doc, ssil_tsquery($1, true), 32) AS text_rank,
              similarity(search_text, ssil_normalize($1)) AS trgm,
              word_similarity(ssil_normalize_plain($1), search_text) AS word_trgm
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

/** Who is signed in, and what they may do. */
adminRouter.get(
  '/me',
  handle(async (req, res) => {
    res.json({ user: req.user });
  }),
);

/**
 * Invitations.
 *
 * The only way into the admin. An uninvited Google account that signs in
 * successfully is still refused, because anyone can obtain a Google account and
 * this admin publishes a directory people rely on in emergencies.
 */
adminRouter.get(
  '/invites',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.created_at
         FROM invites i ORDER BY i.created_at DESC LIMIT 100`,
    );
    const users = await query(
      `SELECT id, email, name, role, active, last_login_at FROM users ORDER BY created_at`,
    );
    res.json({ invites: rows, users: users.rows });
  }),
);

adminRouter.post(
  '/invites',
  handle(async (req, res) => {
    const body = req.body as { email?: string; role?: string; organization_id?: string };
    if (!body.email) {
      res.status(400).json({ error: 'bad_request', message: 'email is required' });
      return;
    }
    const roles = ['admin', 'editor', 'tagger', 'org_manager', 'viewer'];
    const role = roles.includes(body.role ?? '') ? body.role : 'viewer';

    // Generated here rather than in SQL: gen_random_bytes lives in pgcrypto,
    // which is not installed, while gen_random_uuid is a Postgres builtin.
    const token = randomBytes(24).toString('hex');
    const { rows } = await query(
      `INSERT INTO invites (email, role, organization_id, token, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '14 days')
       ON CONFLICT (lower(email)) WHERE accepted_at IS NULL
       DO UPDATE SET role = EXCLUDED.role, expires_at = EXCLUDED.expires_at
       RETURNING id, email, role, expires_at`,
      [body.email.toLowerCase(), role, body.organization_id ?? null, token],
    );

    res.status(201).json({
      ...rows[0],
      // There is no email to click: the invited person signs in with Google and
      // is recognised. Saying so avoids someone waiting for a message.
      note: 'Tell them to sign in with Google at /admin — no invitation email is sent.',
    });
  }),
);

adminRouter.post(
  '/users/:id/role',
  handle(async (req, res) => {
    const roles = ['admin', 'editor', 'tagger', 'org_manager', 'viewer'];
    const role = String(req.query['role'] ?? '');
    if (!roles.includes(role)) {
      res.status(400).json({ error: 'bad_request', message: `role must be one of: ${roles.join(', ')}` });
      return;
    }
    const { rowCount } = await query('UPDATE users SET role = $2 WHERE id = $1', [req.params['id'], role]);
    res.status(rowCount ? 200 : 404).json({ updated: (rowCount ?? 0) > 0, role });
  }),
);

/** The corpus at a glance: what is live, what is waiting, what is broken. */
adminRouter.get(
  '/overview',
  handle(async (_req, res) => {
    const { rows } = await query(`
      SELECT
        (SELECT count(*) FROM cards)::int                                        AS cards,
        (SELECT count(*) FROM services)::int                                     AS services_total,
        (SELECT count(*) FROM services WHERE status = 'published')::int          AS services_published,
        (SELECT count(*) FROM services WHERE status = 'draft')::int              AS services_draft,
        (SELECT count(*) FROM organizations)::int                                AS organizations,
        (SELECT count(*) FROM branches)::int                                     AS branches,
        (SELECT count(*) FROM card_rejections)::int                              AS rejections,
        (SELECT count(*) FROM moderation_queue WHERE status = 'pending')::int    AS pending_review,
        (SELECT count(*) FROM feedback_reports WHERE status = 'open')::int       AS open_reports,
        (SELECT count(*) FROM locations
          WHERE NOT national_service AND geom IS NULL)::int                      AS unresolved_locations,
        (SELECT count(*) FROM entity_taxonomy WHERE origin = 'llm')::int         AS tag_suggestions,
        (SELECT count(*) FROM search_events
          WHERE outcome = 'empty' AND at > now() - interval '30 days')::int       AS empty_searches_30d,
        -- Searches that did not run, as opposed to searches that ran and found
        -- nothing. A number above zero here is a bug, not a content gap.
        (SELECT count(*) FROM search_events
          WHERE outcome NOT IN ('ok', 'empty') AND at > now() - interval '7 days')::int AS failed_searches_7d,
        (SELECT value FROM system_state WHERE key = 'cards_need_rebuild')        AS rebuild_pending,
        (SELECT max(updated_at) FROM cards)                                      AS last_updated
    `);
    res.json(rows[0] ?? {});
  }),
);

/** Reports from the public. */
adminRouter.get(
  '/reports',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT f.id, f.card_id, f.kind, f.message, f.contact, f.status, f.created_at,
              c.service_name, c.organization_name
         FROM feedback_reports f
         LEFT JOIN cards c ON c.card_id = f.card_id
        WHERE f.status = 'open'
        ORDER BY f.created_at DESC LIMIT 200`,
    );
    res.json({ reports: rows });
  }),
);

adminRouter.post(
  '/reports/:id',
  handle(async (req, res) => {
    const status = String(req.query['status'] ?? 'acknowledged');
    if (!['acknowledged', 'fixed', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const { rowCount } = await query(
      `UPDATE feedback_reports SET status = $2, resolved_at = now() WHERE id = $1`,
      [req.params['id'], status],
    );
    res.status(rowCount ? 200 : 404).json({ updated: (rowCount ?? 0) > 0 });
  }),
);

/**
 * Imports a taxonomy from an export, extending the vendored tree.
 *
 * The upstream YAML is not always the whole story: a working corpus carries
 * nodes added locally, and — more valuable — the synonyms editors have built up
 * over years. Those are what let a search for "קצבה" reach a category named
 * "סיוע כספי", and they exist nowhere in the published taxonomy file.
 *
 * Parents are derived from the slug rather than trusted from the payload, since
 * the id already encodes the hierarchy and a mismatch between the two is a
 * silent way to lose a whole branch of the tree.
 */
adminRouter.post(
  '/taxonomy/import',
  handle(async (req, res) => {
    const body = req.body as {
      nodes?: {
        id: string;
        axis: 'response' | 'situation';
        name?: string;
        name_en?: string;
        description?: string;
        synonyms?: string[];
        pk?: string;
      }[];
    };
    const nodes = body.nodes ?? [];
    if (nodes.length === 0) {
      res.status(400).json({ error: 'bad_request', message: 'nodes is required' });
      return;
    }

    const known = new Set(nodes.map((n) => n.id));
    const existing = await query<{ id: string }>('SELECT id FROM taxonomy_nodes');
    for (const row of existing.rows) known.add(row.id);

    // Shallowest first, so a parent always exists before its children.
    const ordered = [...nodes].sort(
      (a, b) => a.id.split(':').length - b.id.split(':').length || a.id.localeCompare(b.id),
    );

    let created = 0;
    let names = 0;
    let synonyms = 0;
    const skipped: string[] = [];

    await transaction(async (client) => {
      for (const node of ordered) {
        const parts = node.id.split(':');
        const parentId = parts.length > 2 ? parts.slice(0, -1).join(':') : null;
        // A node whose parent is absent would be unreachable by any filter, so
        // it is reported rather than attached to the root and hidden there.
        if (parentId && !known.has(parentId)) {
          skipped.push(`${node.id} (parent ${parentId} is missing)`);
          continue;
        }

        await client.query(
          `INSERT INTO taxonomy_nodes (id, axis, parent_id, depth, pk_uuid, active)
           VALUES ($1, $2::ssil_axis, $3, $4, $5, true)
           ON CONFLICT (id) DO UPDATE SET
             axis = EXCLUDED.axis, parent_id = EXCLUDED.parent_id,
             depth = EXCLUDED.depth, active = true, updated_at = now()`,
          [node.id, node.axis, parentId, Math.max(parts.length - 2, 0), node.pk ?? null],
        );
        created += 1;

        for (const [lang, name, description] of [
          ['he', node.name, node.description],
          ['en', node.name_en, undefined],
        ] as const) {
          if (!name) continue;
          await client.query(
            `INSERT INTO taxonomy_names (node_id, lang, name, description)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (node_id, lang) DO UPDATE SET
               name = EXCLUDED.name,
               description = COALESCE(EXCLUDED.description, taxonomy_names.description)`,
            [node.id, lang, name, description ?? null],
          );
          names += 1;
        }

        for (const term of node.synonyms ?? []) {
          if (!term.trim()) continue;
          await client.query(
            `INSERT INTO taxonomy_synonyms (node_id, lang, term) VALUES ($1, 'he', $2)
             ON CONFLICT DO NOTHING`,
            [node.id, term.trim()],
          );
          synonyms += 1;
        }
      }

      await client.query('SELECT rebuild_taxonomy_closure()');
    });

    await query('SELECT refresh_taxonomy_counts()');
    res.json({ nodes: created, names, synonyms, skipped });
  }),
);

/**
 * The MCP servers the site's own search can reach.
 *
 * Registering a URL here is what makes another organisation's corpus
 * searchable, without anyone writing an integration for it: an MCP server
 * describes its own tools, so the search discovers what it can do at request
 * time.
 */
adminRouter.get(
  '/mcp-servers',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, slug, name, url, description, enabled, is_self,
              auth_header IS NOT NULL AS has_credential,
              last_checked_at, last_status, tool_count
         FROM mcp_servers ORDER BY is_self DESC, name`,
    );
    res.json({ servers: rows });
  }),
);

adminRouter.post(
  '/mcp-servers',
  handle(async (req, res) => {
    const body = req.body as {
      slug?: string; name?: string; url?: string; description?: string;
      auth_header?: string; enabled?: boolean;
    };
    if (!body.slug || !body.name || !body.url) {
      res.status(400).json({ error: 'bad_request', message: 'slug, name and url are required' });
      return;
    }

    const { rows } = await query(
      `INSERT INTO mcp_servers (slug, name, url, description, auth_header, enabled)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true))
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, url = EXCLUDED.url, description = EXCLUDED.description,
         -- An omitted credential leaves the stored one alone, so editing a
         -- server's name does not silently drop its key.
         auth_header = COALESCE(EXCLUDED.auth_header, mcp_servers.auth_header),
         enabled = EXCLUDED.enabled, updated_at = now()
       RETURNING id, slug, name, url, enabled`,
      [body.slug, body.name, body.url, body.description ?? null,
       body.auth_header ?? null, body.enabled ?? null],
    );
    res.status(201).json(rows[0]);
  }),
);

/** Connects and lists the tools. Needs no model credentials, so it is the
 *  cheapest way to find out whether a URL is actually a working MCP server. */
adminRouter.post(
  '/mcp-servers/:id/test',
  handle(async (req, res) => {
    res.json(await testServer(req.params['id'] as string, baseUrlOf(req)));
  }),
);

adminRouter.post(
  '/mcp-servers/:id/toggle',
  handle(async (req, res) => {
    const { rows } = await query<{ enabled: boolean }>(
      `UPDATE mcp_servers SET enabled = NOT enabled, updated_at = now()
        WHERE id = $1 RETURNING enabled`,
      [req.params['id']],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ enabled: rows[0].enabled });
  }),
);

adminRouter.delete(
  '/mcp-servers/:id',
  handle(async (req, res) => {
    // The site's own server is not removable: without it the search has no
    // corpus, and that is a confusing way to break the front page.
    const { rowCount } = await query('DELETE FROM mcp_servers WHERE id = $1 AND NOT is_self', [
      req.params['id'],
    ]);
    res.status(rowCount ? 200 : 400).json({
      deleted: (rowCount ?? 0) > 0,
      ...(rowCount ? {} : { message: 'The local corpus server cannot be removed.' }),
    });
  }),
);

/** What every enabled server currently offers — one place to see the surface. */
adminRouter.get(
  '/mcp-servers/tools',
  handle(async (req, res) => {
    const servers = await listServers();
    const results = [];
    for (const server of servers) {
      results.push({ slug: server.slug, name: server.name, ...(await testServer(server.id, baseUrlOf(req))) });
    }
    res.json({ servers: results });
  }),
);
