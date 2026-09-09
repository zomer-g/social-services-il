import { Router, type Request, type Response } from 'express';
import { query, searchCards } from '@ssil/db';
import { LANGS, type Lang } from '@ssil/core';
import { BadRequest, bbox, int, list, num, oneOf, point, str } from '../params.js';
import { outcomeFor, recordSearch } from '../searchlog.js';

/**
 * The public read API.
 *
 * Versioned in the path and documented in docs/openapi.yaml. Everything here is
 * public information and is served with open CORS, because the point of
 * publishing it is that other people build on it.
 */
export const v1Router: Router = Router();

/** Responses are cacheable: the corpus changes on publish, not per request. */
const CACHE = 'public, max-age=60, stale-while-revalidate=600';

function langOf(req: Request): Lang {
  const raw = str(req.query as Record<string, unknown>, 'lang');
  return (LANGS as readonly string[]).includes(raw ?? '') ? (raw as Lang) : 'he';
}

/** Wraps a handler so a thrown BadRequest becomes a 400 rather than a 500. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      if (err instanceof BadRequest) {
        res.status(400).json({ error: 'bad_request', message: err.message, field: err.field });
        return;
      }
      console.error('[error] v1 handler:', err.stack ?? err.message);
      res.status(500).json({ error: 'internal_error' });
    });
  };
}

v1Router.get(
  '/search',
  handle(async (req, res) => {
    const started = Date.now();
    const q = req.query as Record<string, unknown>;
    const at = point(q);
    const lang = langOf(req);

    const result = await searchCards({
      q: str(q, 'q'),
      responses: list(q, 'response'),
      situations: list(q, 'situation'),
      lat: at?.lat,
      lon: at?.lon,
      radiusKm: num(q, 'radius_km', { min: 0.1, max: 500 }),
      bbox: bbox(q),
      city: str(q, 'city'),
      organizationId: str(q, 'organization_id'),
      nationalService: oneOf(q, 'national_service', ['only', 'exclude'] as const),
      collapse: str(q, 'collapse') === 'false' ? false : undefined,
      limit: int(q, 'limit', { min: 1, max: 100 }),
      offset: int(q, 'offset', { min: 0, max: 10_000 }),
      lang,
    });

    // What people looked for and whether the corpus could answer, with no
    // identifier attached. A run of zero-result searches is the clearest signal
    // the admin gets about which services to go and collect next.
    recordSearch({
      kind: 'plain',
      outcome: outcomeFor(result.total),
      query: str(q, 'q') ?? null,
      responseIds: list(q, 'response') ?? [],
      situationIds: list(q, 'situation') ?? [],
      city: str(q, 'city') ?? null,
      hasLocation: at !== undefined,
      lang,
      resultCount: result.total,
      // The first page only: the log exists so somebody can see what came back,
      // and the answer to "was this search any good" is on the first screen.
      cardIds: result.cards.map((c) => c.card_id),
      durationMs: Date.now() - started,
    });

    res.set('Cache-Control', CACHE).json(result);
  }),
);

v1Router.get(
  '/cards/:cardId',
  handle(async (req, res) => {
    const { rows } = await query(
      `SELECT c.card_id, c.service_id, c.branch_id, c.organization_id,
              c.service_name, c.service_description,
              s.details AS service_details,
              s.payment_required, s.payment_details,
              s.urls AS service_urls, s.email_address AS service_email,
              s.implements, s.data_sources,
              c.organization_name, c.organization_short_name, c.organization_kind,
              c.organization_branch_count,
              o.purpose AS organization_purpose, o.description AS organization_description,
              o.urls AS organization_urls, o.email_address AS organization_email,
              c.branch_name, c.address, c.city,
              b.address_details, b.urls AS branch_urls, b.email_address AS branch_email,
              ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon,
              c.national_service, c.location_accurate, c.phone_numbers,
              c.score, c.updated_at,
              (SELECT json_agg(json_build_object('id', t.node_id, 'name', tn.name) ORDER BY tn.name)
                 FROM unnest(c.response_ids) AS t(node_id)
                 LEFT JOIN taxonomy_names tn ON tn.node_id = t.node_id AND tn.lang = $2) AS responses,
              (SELECT json_agg(json_build_object('id', t.node_id, 'name', tn.name) ORDER BY tn.name)
                 FROM unnest(c.situation_ids) AS t(node_id)
                 LEFT JOIN taxonomy_names tn ON tn.node_id = t.node_id AND tn.lang = $2) AS situations,
              -- Everything else available at the same place. Someone who has
              -- found the right desk should see what else that desk offers.
              (SELECT json_agg(json_build_object(
                        'card_id', o2.card_id, 'service_name', o2.service_name,
                        'service_description', o2.service_description))
                 FROM cards o2
                WHERE o2.branch_id IS NOT DISTINCT FROM c.branch_id
                  AND o2.organization_id = c.organization_id
                  AND o2.card_id <> c.card_id) AS also_at_this_branch
         FROM cards c
         JOIN services s ON s.id = c.service_id
         JOIN organizations o ON o.id = c.organization_id
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE c.card_id = $1`,
      [req.params['cardId'], langOf(req)],
    );

    const card = rows[0];
    if (!card) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.set('Cache-Control', CACHE).json(card);
  }),
);

v1Router.get(
  '/taxonomy',
  handle(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const axis = oneOf(q, 'axis', ['response', 'situation'] as const);
    const lang = langOf(req);
    const withEmpty = str(q, 'include_empty') === 'true';

    const { rows } = await query(
      `SELECT n.id, n.axis, n.parent_id, n.depth,
              nm.name, nm.description,
              COALESCE(cc.card_count, 0) AS card_count,
              COALESCE((SELECT array_agg(s.term ORDER BY s.term)
                          FROM taxonomy_synonyms s
                         WHERE s.node_id = n.id AND s.lang = $2), '{}') AS synonyms
         FROM taxonomy_nodes n
         LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = $2
         LEFT JOIN taxonomy_card_counts cc ON cc.node_id = n.id
        WHERE n.active
          AND ($1::text IS NULL OR n.axis = $1::ssil_axis)
          AND ($3::boolean OR COALESCE(cc.card_count, 0) > 0)
        ORDER BY n.axis, n.depth, n.sort_order`,
      [axis ?? null, lang, withEmpty],
    );

    res.set('Cache-Control', CACHE).json({ nodes: rows });
  }),
);

v1Router.get(
  '/autocomplete',
  handle(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const term = str(q, 'q');
    if (!term) {
      res.json({ taxonomy: [], services: [] });
      return;
    }
    const lang = langOf(req);
    const limit = int(q, 'limit', { min: 1, max: 25 }) ?? 8;

    // Two kinds of suggestion, because people type two kinds of thing: a need
    // ("food"), which maps to a category, and a name ("Latet"), which maps to a
    // specific service.
    const taxonomy = await query(
      `SELECT id, axis, name, card_count
         FROM taxonomy_suggestions
        WHERE lang = $2
          AND (search_text % ssil_normalize($1) OR search_text ILIKE '%' || ssil_normalize($1) || '%')
          AND card_count > 0
        ORDER BY similarity(search_text, ssil_normalize($1)) * 2 + ln(1 + card_count) DESC
        LIMIT $3`,
      [term, lang, limit],
    );

    const services = await query(
      `SELECT card_id, service_name, organization_name, city, national_service
         FROM cards
        WHERE search_doc @@ ssil_tsquery($1, true)
        ORDER BY score DESC
        LIMIT $2`,
      [term, limit],
    );

    res.set('Cache-Control', CACHE).json({ taxonomy: taxonomy.rows, services: services.rows });
  }),
);

v1Router.get(
  '/organizations/:id',
  handle(async (req, res) => {
    const { rows } = await query(
      `SELECT o.id, o.name, o.short_name, o.kind, o.purpose, o.description,
              o.urls, o.phone_numbers, o.email_address, o.updated_at,
              (SELECT count(*)::int FROM branches b
                WHERE b.organization_id = o.id AND b.status = 'published') AS branch_count,
              (SELECT json_agg(json_build_object(
                        'card_id', c.card_id, 'service_name', c.service_name,
                        'service_description', c.service_description,
                        'city', c.city, 'national_service', c.national_service)
                      ORDER BY c.score DESC)
                 FROM cards c WHERE c.organization_id = o.id) AS services
         FROM organizations o
        WHERE o.id = $1 AND o.status = 'published'`,
      [req.params['id']],
    );

    const org = rows[0];
    if (!org) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.set('Cache-Control', CACHE).json(org);
  }),
);

v1Router.get(
  '/stats',
  handle(async (_req, res) => {
    const { rows } = await query(`
      SELECT
        (SELECT count(*) FROM cards)::int                                       AS cards,
        (SELECT count(*) FROM services WHERE status = 'published')::int         AS services,
        (SELECT count(*) FROM organizations WHERE status = 'published')::int    AS organizations,
        (SELECT count(*) FROM branches WHERE status = 'published')::int         AS branches,
        (SELECT count(*) FROM cards WHERE national_service)::int                AS national_services,
        (SELECT count(DISTINCT city) FROM cards WHERE city IS NOT NULL)::int    AS cities,
        (SELECT count(*) FROM taxonomy_nodes WHERE active)::int                 AS taxonomy_nodes,
        (SELECT max(updated_at) FROM cards)                                     AS last_updated
    `);
    res.set('Cache-Control', CACHE).json(rows[0] ?? {});
  }),
);

/**
 * Bulk export — the thing that does not exist today for this data.
 *
 * `updated_since` makes incremental mirroring possible, so a consumer does not
 * have to re-download the whole corpus to notice one changed phone number.
 * Streamed as newline-delimited JSON to keep memory flat.
 */
v1Router.get(
  '/export/cards.ndjson',
  handle(async (req, res) => {
    const since = str(req.query as Record<string, unknown>, 'updated_since') ?? null;
    const { rows } = await query(
      `SELECT card_id, service_id, branch_id, organization_id,
              service_name, service_description, organization_name, organization_kind,
              branch_name, address, city,
              ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon,
              national_service, location_accurate, phone_numbers,
              response_ids, situation_ids, updated_at
         FROM cards
        WHERE $1::timestamptz IS NULL OR updated_at >= $1::timestamptz
        ORDER BY card_id`,
      [since],
    );

    res.type('application/x-ndjson').set('Cache-Control', CACHE);
    for (const row of rows) res.write(`${JSON.stringify(row)}\n`);
    res.end();
  }),
);

/**
 * "Something here is wrong."
 *
 * The people using this site are the only ones who find out that a phone number
 * is dead or a service has closed, and they find out at the worst possible
 * moment. Reporting it has to cost one sentence and no account.
 */
v1Router.post(
  '/feedback',
  handle(async (req, res) => {
    const body = (req.body ?? {}) as { card_id?: string; kind?: string; message?: string; contact?: string };
    const message = (body.message ?? '').trim();
    if (message.length < 3) {
      throw new BadRequest('message is required', 'message');
    }

    const kinds = ['error', 'closed', 'wrong_phone', 'wrong_address', 'other'];
    const kind = kinds.includes(body.kind ?? '') ? body.kind : 'error';

    await query(
      `INSERT INTO feedback_reports (card_id, service_id, kind, message, contact)
       VALUES ($1, (SELECT service_id FROM cards WHERE card_id = $1), $2, $3, $4)`,
      [body.card_id ?? null, kind, message.slice(0, 2000), (body.contact ?? '').slice(0, 200) || null],
    );

    res.status(201).json({ ok: true });
  }),
);
