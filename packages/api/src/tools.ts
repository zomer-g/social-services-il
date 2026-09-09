import { z } from 'zod';
import { query, searchCards } from '@ssil/db';

/**
 * The tools, defined once.
 *
 * Both the MCP server and the site's smart search run on these. That is the
 * point: what an assistant can ask for through MCP and what the search box does
 * on someone's behalf are the same set of operations, so the two cannot drift
 * into answering the same question differently.
 *
 * Every tool is read-only.
 */

export const LangSchema = z
  .enum(['he', 'ar', 'ru', 'en'])
  .default('he')
  .describe('Language for taxonomy names in the response.');

export interface SharedTool {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape: MCP takes it directly, the Messages API via toJSONSchema. */
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * How the corpus is organised, in the words an assistant needs to use it.
 * Shared so the MCP client and the smart search are told the same thing.
 */
export const CORPUS_INSTRUCTIONS = [
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
  'search_services already returns what a person asks for: the street address, every phone',
  'number, who the service is for, what it provides, what it costs and how to apply. Answer',
  'from it directly. get_service is for going deeper on one result, not for filling in gaps',
  'the search left, and calling it once per result is wasted work.',
  '',
  'The same service is often run in many places, and the search shows one of them so that',
  'one body with hundreds of branches does not crowd out everything else. When a result says',
  'also_offered_at_other_places, that count is the rest of them: call list_service_locations',
  'with its card_id to get the branch nearest the person, or the list of towns it operates',
  'in. Never tell someone a service exists only in the town the search happened to return.',
  '',
  'Be concrete. A useful answer names the place, the street and the number to call. Never',
  'invent any of the three: if a field is absent it is genuinely missing from the record,',
  'and saying so is better than filling it in.',
  '',
  'The data is compiled from public sources and can be out of date. last_updated is when the',
  'source last changed the record, where the source says so; it is absent when nobody knows.',
  'Give it when it is there, and tell the person to call before travelling either way.',
].join('\n');

export const sharedTools: SharedTool[] = [
  {
    name: 'search_services',
    title: 'Search social services',
    description:
      'Find services by free text, taxonomy ids, location or city. Free text is matched against Hebrew service names, descriptions and taxonomy synonyms.',
    schema: {
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
    handler: async (args) => {
      const a = args as {
        query?: string; response_ids?: string[]; situation_ids?: string[]; city?: string;
        lat?: number; lon?: number; radius_km?: number; national_only?: boolean;
        limit?: number; lang?: string;
      };
      const result = await searchCards({
        q: a.query,
        responses: a.response_ids,
        situations: a.situation_ids,
        city: a.city,
        lat: a.lat,
        lon: a.lon,
        radiusKm: a.radius_km,
        nationalService: a.national_only ? 'only' : undefined,
        limit: a.limit ?? 10,
        lang: a.lang ?? 'he',
      });

      // Enough to answer with, in one call.
      //
      // The first version returned a name, a city and one phone number, and an
      // assistant reading that had nothing concrete to say: no street address,
      // no eligibility, no idea whether it costs money. It could fetch each
      // result separately, but in practice it answered vaguely instead. What a
      // person actually asks — where do I go, who is it for, what do I need,
      // does it cost — is one join away, so it belongs here.
      const detail = await enrich(
        result.cards.map((c) => c.card_id),
        a.lang ?? 'he',
      );

      return {
        total: result.total,
        showing: result.cards.length,
        services: result.cards.map((c) => {
          const extra = detail.get(c.card_id);
          return {
            card_id: c.card_id,
            name: c.service_name,
            description: c.service_description,
            provider: c.organization_name,
            provider_kind: c.organization_kind,
            // Said in words rather than left for the caller to infer from a
            // null address.
            where: c.national_service
              ? 'ניתן בכל הארץ (available anywhere in the country)'
              : [c.address, c.city].filter(Boolean).join(', ') || null,
            address: c.national_service ? null : c.address,
            city: c.city,
            // Stated plainly: an assistant that reads out a city centroid as an
            // address sends someone to the wrong street.
            location_note:
              !c.national_service && !c.location_accurate
                ? 'המיקום משוער — כדאי לוודא בטלפון לפני הגעה'
                : undefined,
            distance_km: c.distance_m != null ? Number((c.distance_m / 1000).toFixed(1)) : null,
            phones: c.phone_numbers,
            how_to_apply: extra?.details ?? undefined,
            // Three states, not two. Most records say nothing about money,
            // and "free" is not the safe thing to say when nobody knows: the
            // person travels, and is turned away at the door.
            cost: costOf(extra?.payment_required, extra?.payment_details),
            for_whom: extra?.intended_for ?? undefined,
            provides: extra?.provides ?? undefined,
            links: extra?.urls ?? undefined,
            // When the record itself last changed, not when the index was
            // rebuilt, so an assistant can honestly say how old this is.
            last_updated: c.updated_at,
            // A service delivered in many places shows one of them here. This
            // is how a caller learns the others exist and how to reach them.
            also_offered_at_other_places: c.also_available_at || undefined,
            by_other_organizations: c.other_organizations || undefined,
            more_places_tool: c.also_available_at ? 'list_service_locations' : undefined,
            url: `/s/${c.card_id}`,
          };
        }),
        narrow_by: {
          responses: result.facets.responses.slice(0, 8),
          situations: result.facets.situations.slice(0, 8),
        },
      };
    },
  },

  {
    name: 'find_services_near',
    title: 'Find services near a point',
    description: 'Services closest to a coordinate, ordered by distance. Nationwide services are listed separately.',
    schema: {
      lat: z.number(),
      lon: z.number(),
      radius_km: z.number().default(10),
      response_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(10),
      lang: LangSchema,
    },
    handler: async (args) => {
      const a = args as { lat: number; lon: number; radius_km?: number; response_id?: string; limit?: number; lang?: string };
      const result = await searchCards({
        lat: a.lat,
        lon: a.lon,
        radiusKm: a.radius_km ?? 10,
        responses: a.response_id ? [a.response_id] : undefined,
        limit: a.limit ?? 10,
        lang: a.lang ?? 'he',
      });
      const local = result.cards.filter((c) => !c.national_service);
      const national = result.cards.filter((c) => c.national_service);
      return {
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
      };
    },
  },

  {
    name: 'get_service',
    title: 'Get one service',
    description: 'Everything known about one service at one place, by card id.',
    schema: { card_id: z.string(), lang: LangSchema },
    handler: async (args) => {
      const a = args as { card_id: string; lang?: string };
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
        [a.card_id, a.lang ?? 'he'],
      );
      return rows[0] ?? `No service with card id ${a.card_id}.`;
    },
  },

  {
    name: 'find_taxonomy',
    title: 'Find taxonomy categories',
    description:
      'Turn a description of a need into taxonomy ids. Returns how many services sit under each, so a category with none can be avoided.',
    schema: {
      query: z.string().describe('A need in words, e.g. "food" or "אלימות במשפחה".'),
      axis: z.enum(['response', 'situation']).optional(),
      lang: LangSchema,
      limit: z.number().int().min(1).max(30).default(10),
    },
    handler: async (args) => {
      const a = args as { query: string; axis?: string; lang?: string; limit?: number };
      const { rows } = await query(
        `SELECT id, axis, name, card_count
           FROM taxonomy_suggestions
          WHERE lang = $2
            AND ($4::text IS NULL OR axis = $4::ssil_axis)
            AND (search_text % ssil_normalize($1) OR search_text ILIKE '%' || ssil_normalize($1) || '%')
          ORDER BY similarity(search_text, ssil_normalize($1)) * 2 + ln(1 + card_count) DESC
          LIMIT $3`,
        [a.query, a.lang ?? 'he', a.limit ?? 10, a.axis ?? null],
      );
      return { matches: rows };
    },
  },

  {
    name: 'list_taxonomy',
    title: 'Browse the taxonomy',
    description: 'The category tree, or the children of one node. Use to explore what the corpus can answer.',
    schema: {
      axis: z.enum(['response', 'situation']).optional(),
      parent_id: z.string().optional().describe('Omit for top-level categories.'),
      lang: LangSchema,
      include_empty: z.boolean().default(false),
    },
    handler: async (args) => {
      const a = args as { axis?: string; parent_id?: string; lang?: string; include_empty?: boolean };
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
        [a.axis ?? null, a.parent_id ?? null, a.lang ?? 'he', a.include_empty ?? false],
      );
      return { nodes: rows };
    },
  },

  {
    name: 'get_organization',
    title: 'Get an organization and its services',
    description: 'One provider, with everything it offers.',
    schema: { organization_id: z.string(), lang: LangSchema },
    handler: async (args) => {
      const a = args as { organization_id: string };
      const { rows } = await query(
        `SELECT o.id, o.name, o.short_name, o.kind, o.purpose, o.urls, o.phone_numbers,
                (SELECT count(*)::int FROM branches b WHERE b.organization_id = o.id AND b.status = 'published') AS branches,
                (SELECT json_agg(json_build_object('card_id', c.card_id, 'name', c.service_name,
                                                   'city', c.city, 'nationwide', c.national_service))
                   FROM cards c WHERE c.organization_id = o.id) AS services
           FROM organizations o
          WHERE o.id = $1 AND o.status = 'published'`,
        [a.organization_id],
      );
      return rows[0] ?? `No organization with id ${a.organization_id}.`;
    },
  },

  {
    name: 'emergency_lines',
    title: 'Emergency helplines',
    description:
      'Nationally published helplines that answer immediately. Use this before searching when someone describes danger, self-harm or violence.',
    schema: {},
    handler: async () =>
      // Hard-coded rather than queried: this must answer even when the corpus
      // cannot, and these numbers are stable national infrastructure.
      ({
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
  },

  {
    name: 'corpus_stats',
    title: 'Corpus statistics',
    description: 'How much data there is and when it was last updated — use to judge whether an answer is well covered.',
    schema: {},
    handler: async () => {
      const { rows } = await query(`
        SELECT (SELECT count(*) FROM cards)::int AS services_at_places,
               (SELECT count(*) FROM services WHERE status = 'published')::int AS distinct_services,
               (SELECT count(*) FROM organizations WHERE status = 'published')::int AS organizations,
               (SELECT count(*) FROM cards WHERE national_service)::int AS nationwide,
               (SELECT count(DISTINCT city) FROM cards WHERE city IS NOT NULL)::int AS cities,
               (SELECT max(updated_at) FROM cards) AS last_updated
      `);
      return rows[0] ?? {};
    },
  },
  {
    name: 'list_service_locations',
    title: 'Where a service is offered',
    description:
      'Every place one service is delivered, nearest first when a location is given. Search collapses a service offered in many places down to a single row; this is how to see the rest.',
    schema: {
      card_id: z.string().optional().describe('Any card of the service — the one a search returned.'),
      service_id: z.string().optional().describe('The service id, if that is what you have.'),
      lat: z.number().optional(),
      lon: z.number().optional(),
      city: z.string().optional().describe('Only places in this city.'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    handler: async (args) => {
      const a = args as {
        card_id?: string; service_id?: string; lat?: number; lon?: number; city?: string; limit?: number;
      };
      if (!a.card_id && !a.service_id) return 'Give either card_id or service_id.';

      const { rows } = await query(
        `WITH target AS (
           SELECT collapse_key, service_name
             FROM cards
            WHERE ($1::text IS NOT NULL AND card_id = $1)
               OR ($2::text IS NOT NULL AND service_id = $2)
            LIMIT 1
         )
         SELECT c.card_id, t.service_name, c.organization_name, c.address, c.city,
                c.phone_numbers, c.national_service, c.location_accurate, c.updated_at,
                CASE WHEN $3::float8 IS NOT NULL AND c.geom IS NOT NULL
                     THEN round((ST_Distance(c.geom,
                          ST_SetSRID(ST_MakePoint($3::float8, $4::float8), 4326)::geography) / 1000.0)::numeric, 1)
                END AS distance_km
           FROM cards c
           JOIN target t ON t.collapse_key = c.collapse_key
          WHERE ($5::text IS NULL OR c.city = $5::text)
          ORDER BY
            CASE WHEN $3::float8 IS NOT NULL AND c.geom IS NOT NULL
                 THEN ST_Distance(c.geom, ST_SetSRID(ST_MakePoint($3::float8, $4::float8), 4326)::geography)
            END NULLS LAST,
            c.city
          LIMIT $6`,
        [a.card_id ?? null, a.service_id ?? null, a.lon ?? null, a.lat ?? null, a.city ?? null, a.limit ?? 50],
      );

      if (rows.length === 0) return 'No service found for that id.';

      return {
        service_name: (rows[0] as { service_name: string }).service_name,
        places: rows.length,
        // Towns first: "is there one near me" is usually answered by a list of
        // places rather than by fifty addresses.
        cities: [...new Set(rows.map((r) => (r as { city: string | null }).city).filter(Boolean))],
        locations: rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            card_id: row['card_id'],
            provider: row['organization_name'],
            address: row['national_service'] ? null : row['address'],
            city: row['city'],
            distance_km: row['distance_km'],
            phones: row['phone_numbers'],
            nationwide: row['national_service'],
            location_note:
              !row['national_service'] && !row['location_accurate']
                ? 'המיקום משוער — כדאי לוודא בטלפון'
                : undefined,
            url: `/s/${String(row['card_id'])}`,
          };
        }),
      };
    },
  },
];

/**
 * The fields a person actually needs that do not live on the card: how to
 * apply, what it costs, who it is for, and any link.
 *
 * Fetched for a whole page of results in one statement rather than left to the
 * caller to request service by service — a caller that must make ten more round
 * trips to answer one question will answer it vaguely instead.
 */
/** Says nothing when the source said nothing. See migration 015. */
function costOf(required: boolean | null | undefined, details: string | null | undefined) {
  if (required === true) return details ?? 'כרוך בתשלום';
  if (required === false) return 'ללא תשלום';
  return undefined;
}

async function enrich(
  cardIds: string[],
  lang: string,
): Promise<
  Map<
    string,
    {
      details: string | null;
      payment_required: boolean | null;
      payment_details: string | null;
      urls: unknown;
      provides: string[] | null;
      intended_for: string[] | null;
    }
  >
> {
  if (cardIds.length === 0) return new Map();

  const { rows } = await query(
    `SELECT c.card_id, s.details, s.payment_required, s.payment_details,
            CASE WHEN jsonb_array_length(s.urls) > 0 THEN s.urls END AS urls,
            (SELECT array_agg(tn.name) FROM unnest(c.response_ids) AS t(id)
               JOIN taxonomy_names tn ON tn.node_id = t.id AND tn.lang = $2) AS provides,
            (SELECT array_agg(tn.name) FROM unnest(c.situation_ids) AS t(id)
               JOIN taxonomy_names tn ON tn.node_id = t.id AND tn.lang = $2) AS intended_for
       FROM cards c
       JOIN services s ON s.id = c.service_id
      WHERE c.card_id = ANY($1::text[])`,
    [cardIds, lang],
  );

  return new Map(
    rows.map((r) => {
      const row = r as Record<string, unknown>;
      return [
        String(row['card_id']),
        {
          details: (row['details'] as string) ?? null,
          payment_required:
            row['payment_required'] === null || row['payment_required'] === undefined
              ? null
              : Boolean(row['payment_required']),
          payment_details: (row['payment_details'] as string) ?? null,
          urls: row['urls'] ?? null,
          provides: (row['provides'] as string[]) ?? null,
          intended_for: (row['intended_for'] as string[]) ?? null,
        },
      ];
    }),
  );
}

export const toolsByName = new Map(sharedTools.map((t) => [t.name, t]));
