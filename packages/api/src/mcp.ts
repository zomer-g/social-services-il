import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { query, searchCards } from '@ssil/db';

/**
 * MCP server for the social services corpus.
 *
 * The reason this exists: people increasingly ask an assistant rather than a
 * search box, and "where can my mother get a hot meal near Ramla" is exactly the
 * question this data answers and a general model cannot. Every tool here is
 * read-only and needs no credentials, because the underlying data is public and
 * the point of publishing it is that others can build on it.
 *
 * Each request gets its own server and transport. The corpus is stateless — no
 * session carries anything worth keeping between calls — and a per-request
 * instance means a hung client cannot hold resources.
 */

/** Results are rendered as text: an assistant relays them, it does not parse them. */
function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const LangSchema = z
  .enum(['he', 'ar', 'ru', 'en'])
  .default('he')
  .describe('Language for taxonomy names in the response.');

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'social-services-il', version: '0.1.0' },
    {
      instructions: [
        'Israeli social services: food, housing, money, health, mental health, legal aid and more,',
        'from nonprofits, government ministries and local authorities.',
        '',
        'Services are organised on two axes. A "response" is what a service provides',
        '(human_services:food:food_pantry). A "situation" is who it is for',
        '(human_situations:deprivation:low_income). Filtering by a parent node also matches',
        'everything below it.',
        '',
        'Start with find_taxonomy or list_taxonomy to turn a need into ids, then search_services.',
        'For a question about a place, pass lat/lon or a city: many services are local, and the',
        'ones that are not are marked national_service and reachable from anywhere.',
        '',
        'The data is compiled from public sources and can be out of date. When you relay a',
        'service, give its phone number and say when the record was last updated, so the person',
        'can confirm before travelling.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'search_services',
    {
      title: 'Search social services',
      description:
        'Find services by free text, taxonomy ids, location or city. Free text is matched against Hebrew service names, descriptions and taxonomy synonyms.',
      inputSchema: {
        query: z.string().optional().describe('Free text, in Hebrew or the language of the corpus.'),
        response_ids: z.array(z.string()).optional().describe('Response taxonomy ids; descendants match too.'),
        situation_ids: z.array(z.string()).optional().describe('Situation taxonomy ids; descendants match too.'),
        city: z.string().optional().describe('Exact city name as it appears in the data.'),
        lat: z.number().optional(),
        lon: z.number().optional(),
        radius_km: z.number().optional().describe('Only with lat/lon. Nationwide services are always included.'),
        national_only: z.boolean().optional().describe('Restrict to services available anywhere in the country.'),
        limit: z.number().int().min(1).max(50).default(10),
        lang: LangSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await searchCards({
        q: args.query,
        responses: args.response_ids,
        situations: args.situation_ids,
        city: args.city,
        lat: args.lat,
        lon: args.lon,
        radiusKm: args.radius_km,
        nationalService: args.national_only ? 'only' : undefined,
        limit: args.limit,
        lang: args.lang,
      });

      return asText({
        total: result.total,
        showing: result.cards.length,
        services: result.cards.map((c) => ({
          card_id: c.card_id,
          name: c.service_name,
          description: c.service_description,
          provider: c.organization_name,
          where: c.national_service ? 'nationwide' : (c.city ?? c.address),
          distance_km: c.distance_m != null ? Number((c.distance_m / 1000).toFixed(1)) : null,
          phone: c.phone_numbers[0] ?? null,
          // Passed through so an assistant can say how fresh the record is
          // rather than implying it is current.
          last_updated: c.updated_at,
          url: `/s/${c.card_id}`,
        })),
        narrow_by: {
          responses: result.facets.responses.slice(0, 8),
          situations: result.facets.situations.slice(0, 8),
        },
      });
    },
  );

  server.registerTool(
    'find_services_near',
    {
      title: 'Find services near a point',
      description: 'Services closest to a coordinate, ordered by distance. Nationwide services are listed separately.',
      inputSchema: {
        lat: z.number(),
        lon: z.number(),
        radius_km: z.number().default(10),
        response_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
        lang: LangSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await searchCards({
        lat: args.lat,
        lon: args.lon,
        radiusKm: args.radius_km,
        responses: args.response_id ? [args.response_id] : undefined,
        limit: args.limit,
        lang: args.lang,
      });
      const local = result.cards.filter((c) => !c.national_service);
      const national = result.cards.filter((c) => c.national_service);
      return asText({
        nearby: local.map((c) => ({
          card_id: c.card_id,
          name: c.service_name,
          provider: c.organization_name,
          address: c.address,
          distance_km: c.distance_m != null ? Number((c.distance_m / 1000).toFixed(1)) : null,
          location_is_approximate: !c.location_accurate,
          phone: c.phone_numbers[0] ?? null,
        })),
        also_available_nationwide: national.map((c) => ({
          card_id: c.card_id,
          name: c.service_name,
          phone: c.phone_numbers[0] ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'get_service',
    {
      title: 'Get one service',
      description: 'Everything known about one service at one place, by card id.',
      inputSchema: { card_id: z.string(), lang: LangSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ card_id, lang }) => {
      const { rows } = await query(
        `SELECT c.card_id, c.service_name, c.service_description, s.details, s.payment_required,
                s.payment_details, s.urls AS service_urls, c.phone_numbers,
                c.organization_name, c.organization_kind, o.purpose AS organization_purpose,
                c.address, c.city, c.national_service, c.location_accurate,
                ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon,
                s.data_sources, c.updated_at,
                (SELECT array_agg(tn.name) FROM unnest(c.response_ids) AS t(id)
                   JOIN taxonomy_names tn ON tn.node_id = t.id AND tn.lang = $2) AS provides,
                (SELECT array_agg(tn.name) FROM unnest(c.situation_ids) AS t(id)
                   JOIN taxonomy_names tn ON tn.node_id = t.id AND tn.lang = $2) AS intended_for
           FROM cards c
           JOIN services s ON s.id = c.service_id
           JOIN organizations o ON o.id = c.organization_id
          WHERE c.card_id = $1`,
        [card_id, lang],
      );
      if (!rows[0]) return asText(`No service with card id ${card_id}.`);
      return asText(rows[0]);
    },
  );

  server.registerTool(
    'find_taxonomy',
    {
      title: 'Find taxonomy categories',
      description:
        'Turn a description of a need into taxonomy ids. Returns how many services sit under each, so a category with none can be avoided.',
      inputSchema: {
        query: z.string().describe('A need in words, e.g. "food" or "אלימות במשפחה".'),
        axis: z.enum(['response', 'situation']).optional(),
        lang: LangSchema,
        limit: z.number().int().min(1).max(30).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query: term, axis, lang, limit }) => {
      const { rows } = await query(
        `SELECT id, axis, name, card_count
           FROM taxonomy_suggestions
          WHERE lang = $2
            AND ($4::text IS NULL OR axis = $4::ssil_axis)
            AND (search_text % ssil_normalize($1) OR search_text ILIKE '%' || ssil_normalize($1) || '%')
          ORDER BY similarity(search_text, ssil_normalize($1)) * 2 + ln(1 + card_count) DESC
          LIMIT $3`,
        [term, lang, limit, axis ?? null],
      );
      return asText({ matches: rows });
    },
  );

  server.registerTool(
    'list_taxonomy',
    {
      title: 'Browse the taxonomy',
      description: 'The category tree, or the children of one node. Use to explore what the corpus can answer.',
      inputSchema: {
        axis: z.enum(['response', 'situation']).optional(),
        parent_id: z.string().optional().describe('Omit for top-level categories.'),
        lang: LangSchema,
        include_empty: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ axis, parent_id, lang, include_empty }) => {
      const { rows } = await query(
        `SELECT n.id, n.axis, n.depth, nm.name, COALESCE(cc.card_count, 0) AS card_count,
                EXISTS (SELECT 1 FROM taxonomy_nodes c WHERE c.parent_id = n.id AND c.active) AS has_children
           FROM taxonomy_nodes n
           LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = $3
           LEFT JOIN taxonomy_card_counts cc ON cc.node_id = n.id
          WHERE n.active
            AND ($1::text IS NULL OR n.axis = $1::ssil_axis)
            AND n.parent_id IS NOT DISTINCT FROM $2::text
            AND ($4::boolean OR COALESCE(cc.card_count, 0) > 0)
          ORDER BY cc.card_count DESC NULLS LAST, n.sort_order`,
        [axis ?? null, parent_id ?? null, lang, include_empty],
      );
      return asText({ nodes: rows });
    },
  );

  server.registerTool(
    'get_organization',
    {
      title: 'Get an organization and its services',
      description: 'One provider, with everything it offers.',
      inputSchema: { organization_id: z.string(), lang: LangSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ organization_id }) => {
      const { rows } = await query(
        `SELECT o.id, o.name, o.short_name, o.kind, o.purpose, o.urls, o.phone_numbers,
                (SELECT count(*)::int FROM branches b WHERE b.organization_id = o.id AND b.status = 'published') AS branches,
                (SELECT json_agg(json_build_object('card_id', c.card_id, 'name', c.service_name,
                                                   'city', c.city, 'nationwide', c.national_service))
                   FROM cards c WHERE c.organization_id = o.id) AS services
           FROM organizations o
          WHERE o.id = $1 AND o.status = 'published'`,
        [organization_id],
      );
      if (!rows[0]) return asText(`No organization with id ${organization_id}.`);
      return asText(rows[0]);
    },
  );

  server.registerTool(
    'emergency_lines',
    {
      title: 'Emergency helplines',
      description:
        'Nationally published helplines that answer immediately. Use this before searching when someone describes danger, self-harm or violence.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      // Hard-coded rather than queried: this must answer even when the corpus
      // cannot, and these numbers are stable national infrastructure.
      asText({
        note: 'Give the number directly. Do not make someone search when they are in danger.',
        lines: [
          { name: 'משטרה / Police', phone: '100' },
          { name: 'מד"א / Ambulance', phone: '101' },
          { name: 'כבאות / Fire', phone: '102' },
          { name: 'ער"ן — עזרה ראשונה נפשית / ERAN emotional first aid', phone: '1201' },
          { name: 'סה"ר — סיוע והקשבה ברשת / online emotional support', phone: 'https://sahar.org.il' },
          { name: 'קו סיוע לנפגעות ונפגעי אלימות במשפחה / domestic violence', phone: '118' },
          { name: 'מרכזי סיוע לנפגעות תקיפה מינית / sexual assault (women)', phone: '1202' },
          { name: 'מרכזי סיוע לנפגעי תקיפה מינית / sexual assault (men)', phone: '1203' },
          { name: 'הקו הפתוח לילדים ונוער / children and youth', phone: '105' },
        ],
      }),
  );

  server.registerTool(
    'corpus_stats',
    {
      title: 'Corpus statistics',
      description: 'How much data there is and when it was last updated — use to judge whether an answer is well covered.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { rows } = await query(`
        SELECT (SELECT count(*) FROM cards)::int AS services_at_places,
               (SELECT count(*) FROM services WHERE status = 'published')::int AS distinct_services,
               (SELECT count(*) FROM organizations WHERE status = 'published')::int AS organizations,
               (SELECT count(*) FROM cards WHERE national_service)::int AS nationwide,
               (SELECT count(DISTINCT city) FROM cards WHERE city IS NOT NULL)::int AS cities,
               (SELECT max(updated_at) FROM cards) AS last_updated
      `);
      return asText(rows[0] ?? {});
    },
  );

  server.registerResource(
    'taxonomy-responses',
    'taxonomy://responses',
    { title: 'Response taxonomy', description: 'What services provide.', mimeType: 'application/json' },
    async (uri) => {
      const { rows } = await query(
        `SELECT n.id, n.parent_id, nm.name, COALESCE(cc.card_count, 0) AS card_count
           FROM taxonomy_nodes n
           LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = 'he'
           LEFT JOIN taxonomy_card_counts cc ON cc.node_id = n.id
          WHERE n.active AND n.axis = 'response' ORDER BY n.id`,
      );
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rows) }] };
    },
  );

  server.registerResource(
    'taxonomy-situations',
    'taxonomy://situations',
    { title: 'Situation taxonomy', description: 'Who services are for.', mimeType: 'application/json' },
    async (uri) => {
      const { rows } = await query(
        `SELECT n.id, n.parent_id, nm.name, COALESCE(cc.card_count, 0) AS card_count
           FROM taxonomy_nodes n
           LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = 'he'
           LEFT JOIN taxonomy_card_counts cc ON cc.node_id = n.id
          WHERE n.active AND n.axis = 'situation' ORDER BY n.id`,
      );
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rows) }] };
    },
  );

  server.registerPrompt(
    'find-help',
    {
      title: 'Find help for a situation',
      description: 'Walk from a description of someone’s circumstances to concrete services they can contact.',
      argsSchema: {
        situation: z.string().describe('What the person is dealing with, in their own words.'),
        place: z.string().optional().describe('City or area, if known.'),
      },
    },
    ({ situation, place }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Someone needs help with: ${situation}`,
              place ? `They are in or near: ${place}` : 'Their location is unknown — ask, or include nationwide services.',
              '',
              'Please:',
              '1. If anything here suggests immediate danger, call emergency_lines first and give the number.',
              '2. Use find_taxonomy to turn this into response and situation ids.',
              '3. Use search_services with those ids and the location.',
              '4. Give at most five options. For each: what it is, who it is for, where, the phone number,',
              '   and when the record was last updated so they know to confirm.',
              '5. Say plainly if the corpus has little for this need, rather than padding the answer.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

/**
 * Handles one MCP request.
 *
 * Stateless: no session id, so nothing is retained between calls and any node
 * can serve any request. The corpus has no per-client state worth keeping.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[error] mcp request:', (err as Error).stack ?? (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}
