/**
 * The OpenAPI description of this API.
 *
 * Written as data in one place rather than as annotations scattered across the
 * routes, and served from the running instance, so what is published cannot
 * describe a version that is no longer deployed. `npm run openapi` writes the
 * same object to docs/openapi.json for the repository.
 */

const SERVER_URL = process.env['PUBLIC_URL'] || 'https://social-services-il-zomerg.xhostd.app';

const taxonomyNote =
  'Taxonomy ids are hierarchical and colon-delimited, e.g. `human_services:food:food_pantry`. ' +
  'Filtering by a parent matches everything beneath it, so `human_services:food` also returns ' +
  'services tagged only `human_services:food:food_pantry`.';

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Israeli social services API',
    version: '1.0.0',
    description: [
      'Social services in Israel — food, housing, money, health, mental health, legal aid and',
      'more — from nonprofits, government ministries and local authorities.',
      '',
      '## The model',
      '',
      'A **service** is something offered. An **organization** offers it. A **branch** is a place',
      'it is offered at. A **card** is one service at one place, and is what search returns and',
      'what the public site links to.',
      '',
      'Services are described on two axes: a **response** is what the service provides, a',
      '**situation** is who it is for. ' + taxonomyNote,
      '',
      'A service with no physical location is marked `national_service`. That is a fact about the',
      'service, not missing data: it is available anywhere in the country. A radius or bounding-box',
      'search always includes such services.',
      '',
      '## Reading',
      '',
      'No key is needed and CORS is open. Please cache: the corpus changes when data is published,',
      'not per request.',
      '',
      '## Writing',
      '',
      'Pushing services needs an API key with the `ingest:write` scope, sent as',
      '`Authorization: Bearer <key>`. Records are identified by your own `external_id` together',
      'with the source the key belongs to, so re-sending the same rows updates rather than',
      'duplicates. Use `dry_run` to see the exact effect before writing anything.',
      '',
      '## Accuracy',
      '',
      'This data is compiled from public sources and can be out of date. Every record carries',
      '`updated_at`, and `location_accurate` is false where the coordinate is a city centroid',
      'rather than the real address. Show both rather than implying a precision the data lacks.',
    ].join('\n'),
    license: { name: 'MIT', url: 'https://github.com/zomer-g/social-services-il/blob/main/LICENSE' },
  },
  servers: [{ url: SERVER_URL }],
  tags: [
    { name: 'Search', description: 'Finding services.' },
    { name: 'Taxonomy', description: 'The two axes services are described on.' },
    { name: 'Records', description: 'Individual services and organizations.' },
    { name: 'Bulk', description: 'Whole-corpus access.' },
    { name: 'Write', description: 'Submitting and updating services.' },
  ],
  paths: {
    '/api/v1/search': {
      get: {
        tags: ['Search'],
        summary: 'Search services',
        description:
          'Free text, taxonomy, location and city filters, with facet counts for the whole ' +
          'result set. Free text is matched against Hebrew names, descriptions and taxonomy ' +
          'synonyms, with prefix handling and a trigram fallback for misspellings.',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Free text.' },
          { name: 'response', in: 'query', schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: true, description: 'Response ids; repeatable or comma-separated.' },
          { name: 'situation', in: 'query', schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: true, description: 'Situation ids.' },
          { name: 'lat', in: 'query', schema: { type: 'number' }, description: 'With `lon`: rank by proximity and report distances.' },
          { name: 'lon', in: 'query', schema: { type: 'number' } },
          { name: 'radius_km', in: 'query', schema: { type: 'number', minimum: 0.1, maximum: 500 }, description: 'Hard cutoff. Nationwide services are still included.' },
          { name: 'bbox', in: 'query', schema: { type: 'string' }, description: 'west,south,east,north — for a map viewport.' },
          { name: 'city', in: 'query', schema: { type: 'string' } },
          { name: 'organization_id', in: 'query', schema: { type: 'string' } },
          { name: 'national_service', in: 'query', schema: { type: 'string', enum: ['only', 'exclude'] } },
          { name: 'collapse', in: 'query', schema: { type: 'string', enum: ['true', 'false'], default: 'true' }, description: 'Merge identical services offered by different organizations onto one row.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'lang', in: 'query', schema: { type: 'string', enum: ['he', 'ar', 'ru', 'en'], default: 'he' }, description: 'Language of taxonomy names in the response.' },
        ],
        responses: {
          200: {
            description: 'Matching services, most relevant first.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
        },
      },
    },
    '/api/v1/cards/{cardId}': {
      get: {
        tags: ['Records'],
        summary: 'One service at one place',
        parameters: [
          { name: 'cardId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'lang', in: 'query', schema: { type: 'string', enum: ['he', 'ar', 'ru', 'en'] } },
        ],
        responses: {
          200: { description: 'The full record, including everything else offered at the same place.' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/organizations/{id}': {
      get: {
        tags: ['Records'],
        summary: 'An organization and everything it offers',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The organization.' }, 404: { $ref: '#/components/responses/NotFound' } },
      },
    },
    '/api/v1/taxonomy': {
      get: {
        tags: ['Taxonomy'],
        summary: 'The category tree',
        description: taxonomyNote + ' Categories with no services are hidden unless `include_empty` is set.',
        parameters: [
          { name: 'axis', in: 'query', schema: { type: 'string', enum: ['response', 'situation'] } },
          { name: 'lang', in: 'query', schema: { type: 'string', enum: ['he', 'ar', 'ru', 'en'] } },
          { name: 'include_empty', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: { 200: { description: 'Nodes, each with a card count and any synonyms.' } },
      },
    },
    '/api/v1/autocomplete': {
      get: {
        tags: ['Search'],
        summary: 'Suggestions while typing',
        description: 'Returns both categories and named services, because people type both kinds of thing.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'lang', in: 'query', schema: { type: 'string', enum: ['he', 'ar', 'ru', 'en'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 8, maximum: 25 } },
        ],
        responses: { 200: { description: 'Category and service suggestions.' } },
      },
    },
    '/api/v1/stats': {
      get: { tags: ['Bulk'], summary: 'Corpus size and freshness', responses: { 200: { description: 'Counts and the most recent update.' } } },
    },
    '/api/v1/export/cards.ndjson': {
      get: {
        tags: ['Bulk'],
        summary: 'Every service, as newline-delimited JSON',
        description:
          'Pass `updated_since` to mirror incrementally rather than re-downloading the corpus to ' +
          'find one changed phone number.',
        parameters: [{ name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } }],
        responses: { 200: { description: 'One JSON object per line.', content: { 'application/x-ndjson': {} } } },
      },
    },
    '/api/v1/feedback': {
      post: {
        tags: ['Write'],
        summary: 'Report a problem with a record',
        description: 'No key needed. The people who find out a number is dead are the people who called it.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  card_id: { type: 'string' },
                  kind: { type: 'string', enum: ['error', 'closed', 'wrong_phone', 'wrong_address', 'other'] },
                  message: { type: 'string' },
                  contact: { type: 'string', description: 'Optional, only if you want a reply.' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Recorded.' }, 400: { $ref: '#/components/responses/BadRequest' } },
      },
    },
    '/api/v1/ingest/whoami': {
      get: {
        tags: ['Write'],
        summary: 'What this key can do',
        security: [{ apiKey: [] }],
        responses: {
          200: { description: 'The key\'s source, scopes, and whether its pushes publish immediately or queue for review.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/v1/ingest/services': {
      post: {
        tags: ['Write'],
        summary: 'Create or update services',
        description: [
          'Records are identified by `external_id` within your source, so re-sending the same',
          'rows updates them rather than creating duplicates.',
          '',
          'Errors are reported per item: a batch with one bad record writes the rest and names',
          'the one that failed. Set `dry_run` to see the effect without writing.',
          '',
          'Whether a push is published immediately or queued for review depends on the trust',
          'level of the source your key belongs to. The response says which happened.',
        ].join('\n'),
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/IngestRequest' } } },
        },
        responses: {
          202: { description: 'Processed. Check `results` for the outcome of each item.' },
          200: { description: 'Dry run: what would have happened.' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'The key lacks the ingest:write scope, or is not attached to a source.' },
        },
      },
    },
    '/api/v1/ingest/services/{externalId}': {
      delete: {
        tags: ['Write'],
        summary: 'Withdraw a service',
        description: 'Archived, not deleted: the record and its history survive.',
        security: [{ apiKey: [] }],
        parameters: [{ name: 'externalId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Archived.' }, 404: { $ref: '#/components/responses/NotFound' } },
      },
    },
    '/api/v1/smart-search': {
      post: {
        tags: ['Search'],
        summary: 'Search from a sentence rather than a keyword',
        description: [
          'Takes a description of a situation — "I have no money for food and I am in Tel Aviv" —',
          'works out which taxonomy categories it means, and searches on those.',
          '',
          'Runs on the same tools the MCP endpoint exposes, called server-side. Returns a short',
          'answer, the categories it understood (so a wrong reading can be corrected), and the',
          'matching cards, which are re-read from the database by id rather than produced by the',
          'model.',
          '',
          'Rate limited per client, and unavailable when the server has no model credentials —',
          'check GET /api/v1/smart-search/status first. The ordinary /search endpoint has neither',
          'restriction and should stay the default path.',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['q'],
                properties: {
                  q: { type: 'string', minLength: 2, maxLength: 500 },
                  lat: { type: 'number' },
                  lon: { type: 'number' },
                  lang: { type: 'string', enum: ['he', 'ar', 'ru', 'en'], default: 'he' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'An answer, what was understood, and the matching cards.' },
          400: { $ref: '#/components/responses/BadRequest' },
          429: { description: 'Rate limited. Use /api/v1/search instead.' },
          503: { description: 'Smart search is not configured on this server.' },
        },
      },
    },
    '/api/v1/smart-search/status': {
      get: {
        tags: ['Search'],
        summary: 'Whether smart search is available on this instance',
        responses: { 200: { description: '{ available: boolean }' } },
      },
    },
    '/mcp': {
      post: {
        tags: ['Search'],
        summary: 'Model Context Protocol endpoint',
        description:
          'A JSON-RPC endpoint over the same data, for AI assistants. Tools: search_services, ' +
          'find_services_near, get_service, find_taxonomy, list_taxonomy, get_organization, ' +
          'emergency_lines, corpus_stats. No authentication.',
        responses: { 200: { description: 'A JSON-RPC or SSE response, per the MCP Streamable HTTP transport.' } },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', description: 'An API key with the ingest:write scope.' },
    },
    responses: {
      BadRequest: {
        description: 'The request could not be understood. The body names the field at fault.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: { description: 'A valid API key is required.' },
      NotFound: { description: 'No such record.' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          field: { type: 'string' },
        },
      },
      Card: {
        type: 'object',
        description: 'One service as offered at one place.',
        properties: {
          card_id: { type: 'string', description: 'Stable id; the public site links to /s/{card_id}.' },
          service_id: { type: 'string' },
          organization_id: { type: 'string' },
          service_name: { type: 'string' },
          service_description: { type: ['string', 'null'] },
          organization_name: { type: 'string' },
          organization_kind: { type: ['string', 'null'], description: 'e.g. עמותה, משרד ממשלתי, רשות מקומית.' },
          address: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          lat: { type: ['number', 'null'] },
          lon: { type: ['number', 'null'] },
          national_service: { type: 'boolean', description: 'Available anywhere in the country; has no coordinate.' },
          location_accurate: { type: 'boolean', description: 'False when the point is a city centroid rather than the address.' },
          phone_numbers: { type: 'array', items: { type: 'string' } },
          response_ids: { type: 'array', items: { type: 'string' } },
          situation_ids: { type: 'array', items: { type: 'string' } },
          distance_m: { type: ['number', 'null'], description: 'Present only when the search carried a location.' },
          also_offered_by: { type: 'integer', description: 'How many further organizations this collapsed row stands for.' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      SearchResponse: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Matches in the whole result set, not this page.' },
          cards: { type: 'array', items: { $ref: '#/components/schemas/Card' } },
          facets: {
            type: 'object',
            description: 'Counts across the whole result set, so they still make sense on later pages.',
            properties: {
              responses: { type: 'array', items: { $ref: '#/components/schemas/Facet' } },
              situations: { type: 'array', items: { $ref: '#/components/schemas/Facet' } },
              cities: { type: 'array', items: { $ref: '#/components/schemas/Facet' } },
            },
          },
        },
      },
      Facet: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: ['string', 'null'] }, count: { type: 'integer' } },
      },
      IngestRequest: {
        type: 'object',
        required: ['services'],
        properties: {
          dry_run: { type: 'boolean', default: false, description: 'Report the effect without writing.' },
          services: { type: 'array', minItems: 1, maxItems: 500, items: { $ref: '#/components/schemas/ServiceInput' } },
        },
      },
      ServiceInput: {
        type: 'object',
        required: ['external_id', 'name', 'responses', 'organization'],
        properties: {
          external_id: { type: 'string', description: 'Your id. Re-sending it updates the same record.' },
          name: { type: 'string' },
          description: { type: 'string' },
          details: { type: 'string', description: 'Eligibility, hours, how to apply — free text.' },
          payment_required: { type: 'boolean' },
          payment_details: { type: 'string' },
          phone_numbers: { type: 'array', items: { type: 'string' } },
          email_address: { type: 'string', format: 'email' },
          urls: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' }, title: { type: 'string' } } } },
          responses: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'At least one, or nothing can lead to the service. Unknown ids are rejected.' },
          situations: { type: 'array', items: { type: 'string' } },
          national_service: { type: 'boolean' },
          organization: {
            type: 'object',
            required: ['name'],
            properties: {
              id: { type: 'string', description: 'The Israeli registration number, where there is one. Supplying it lets records from different sources meet.' },
              external_id: { type: 'string' },
              name: { type: 'string' },
              short_name: { type: 'string' },
              kind: { type: 'string' },
              purpose: { type: 'string' },
              phone_numbers: { type: 'array', items: { type: 'string' } },
            },
          },
          branches: {
            type: 'array',
            items: {
              type: 'object',
              required: ['external_id'],
              properties: {
                external_id: { type: 'string' },
                name: { type: 'string' },
                address: { type: 'string' },
                city: { type: 'string' },
                lat: { type: 'number' },
                lon: { type: 'number' },
                phone_numbers: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
} as const;
