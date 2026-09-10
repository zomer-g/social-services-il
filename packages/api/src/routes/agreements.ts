import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { matchService, query, transaction } from '@ssil/db';
import { contentHash } from '@ssil/core';
import { config } from '../config.js';
import { requireRole } from '../auth.js';

/**
 * Reading an agreement, one document at a time, with the bill attached.
 *
 * The pipeline in scripts/agreements.mjs is what an archive of ten thousand
 * documents goes through. This is the same three steps — read, match, act —
 * behind a screen, so that the questions you have before running it on ten
 * thousand can be answered on one: does it understand this kind of document,
 * does it recognise the services we already have, and what will it cost.
 *
 * The cost is the point of this endpoint existing rather than a script alone.
 * A per-document figure measured on real documents is the only honest basis for
 * "and what about the whole archive", and it is the number that decides whether
 * this is a good idea. So every response carries its tokens and its price, split
 * into the parts that behave differently at scale — the cached prompt, which is
 * paid once per run, and the document, which is paid every time.
 */
export const agreementsRouter: Router = Router();

agreementsRouter.use(requireRole('editor'));

const MODEL = 'claude-opus-5';

/**
 * USD per million tokens, per model. Cache writes cost a quarter more than
 * ordinary input and cache reads a tenth of it, which is what makes a large
 * fixed prompt affordable across a batch.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** A document larger than this is not a document, it is an archive. */
const MAX_BYTES = 20 * 1024 * 1024;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = join(HERE, '..', '..', '..', '..', 'prompts', 'agreement-to-service.md');
const SCHEMA_FILE = join(HERE, '..', '..', '..', '..', 'prompts', 'agreement-extraction.schema.json');

/** The slug everything read here is attributed to. Created on first use. */
const SOURCE_SLUG = 'agreements';

const AnalyzeSchema = z.object({
  filename: z.string().min(1).max(300),
  /** Base64 for a PDF; plain text for anything else. Exactly one. */
  data_base64: z.string().optional(),
  text: z.string().max(400_000).optional(),
  match: z.boolean().optional().describe('Ask the corpus whether each extracted service already exists. Default true.'),
});

agreementsRouter.get('/status', (_req, res) => {
  res.json({
    available: config.anthropicApiKey.length > 0,
    model: MODEL,
    prices_usd_per_mtok: PRICES[MODEL],
    max_bytes: MAX_BYTES,
  });
});

agreementsRouter.post('/analyze', (req: Request, res: Response) => {
  void (async () => {
    if (!config.anthropicApiKey) {
      res.status(503).json({ error: 'not_configured', message: 'ANTHROPIC_API_KEY is not set on this server.' });
      return;
    }

    const parsed = AnalyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const { filename, data_base64: base64, text } = parsed.data;
    if (!base64 && !text) {
      res.status(400).json({ error: 'invalid_payload', message: 'Send either data_base64 (a PDF) or text.' });
      return;
    }

    const bytes = base64 ? Buffer.byteLength(base64, 'base64') : Buffer.byteLength(text ?? '', 'utf8');
    if (bytes > MAX_BYTES) {
      res.status(413).json({ error: 'too_large', message: `${(bytes / 1e6).toFixed(1)} MB; the limit is ${MAX_BYTES / 1e6} MB.` });
      return;
    }

    const started = Date.now();
    const { prompt, schema } = await promptAndSchema();
    const client = new Anthropic({ apiKey: config.anthropicApiKey });

    const message = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        // The prompt carries the whole taxonomy and is identical for every
        // document, so it is the cached prefix. This is the difference between
        // a batch costing what the documents cost and costing that plus the
        // prompt ten thousand times over.
        system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: contentFor(filename, base64, text) }],
      })
      .finalMessage();

    if (message.stop_reason === 'refusal') {
      res.status(422).json({
        error: 'declined',
        message: `The model declined this document (${message.stop_details?.category ?? 'no category given'}).`,
      });
      return;
    }

    const answer = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let extraction: Extraction;
    try {
      // Text the document does not carry comes back as "" — the schema cannot
      // make text nullable (see prompts/agreement-extraction.schema.json) — and
      // everything downstream means "absent" by null, so it is converted once, here.
      extraction = blankToNull(JSON.parse(answer)) as Extraction;
    } catch {
      res.status(502).json({ error: 'unparseable', message: answer.slice(0, 500) });
      return;
    }

    extraction.document ??= {} as Extraction['document'];
    extraction.document.external_id ||= slug(filename);
    (extraction.services ?? []).forEach((service, i) => {
      service.external_id ||= `${extraction.document.external_id}-${i + 1}`;
    });

    const matches =
      parsed.data.match === false
        ? []
        : await Promise.all((extraction.services ?? []).map((service) => matchOne(service)));

    res.json({
      filename,
      model: message.model,
      elapsed_ms: Date.now() - started,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cache_read: message.usage.cache_read_input_tokens ?? 0,
        cache_write: message.usage.cache_creation_input_tokens ?? 0,
      },
      cost: costOf(message.model, message.usage),
      extraction,
      warnings: validate(extraction),
      matches,
    });
  })().catch((err: Error) => {
    console.error('[error] agreements analyze:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/**
 * Acts on one decision.
 *
 * Deliberately one service at a time and one click at a time. This screen exists
 * to build confidence in a pipeline, and a button that writes forty records at
 * once is the opposite of that; the script is where volume belongs.
 */
const ApplySchema = z.object({
  action: z.enum(['create', 'link']),
  document: z.object({
    external_id: z.string().min(1).max(200),
    title: z.string().max(400).optional(),
    kind: z.string().max(40).optional(),
  }),
  service: z.record(z.string(), z.unknown()).optional(),
  service_id: z.string().max(300).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

agreementsRouter.post('/apply', (req: Request, res: Response) => {
  void (async () => {
    const parsed = ApplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const { action, document } = parsed.data;
    const actor = req.user?.email ?? 'admin-token';
    const sourceId = await ensureSource();

    if (action === 'link') {
      if (!parsed.data.service_id) {
        res.status(400).json({ error: 'invalid_payload', message: 'service_id is required to link.' });
        return;
      }
      const { rows } = await query<{ id: string }>('SELECT id FROM services WHERE id = $1', [parsed.data.service_id]);
      if (!rows.length) {
        res.status(404).json({ error: 'not_found', message: `No service ${parsed.data.service_id}.` });
        return;
      }

      const title = document.title ?? document.kind ?? 'agreement';
      // Confirmed outright: a person is looking at it and pressing the button,
      // which is exactly the review a proposed link would be waiting for.
      const { rows: link } = await query<{ id: string }>(
        `INSERT INTO service_links (service_id, source_id, external_id, kind, title, confidence,
                                    method, evidence, status, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, 'confirmed', $8, now())
         ON CONFLICT (source_id, external_id, service_id) DO UPDATE SET
           -- Absent is unknown, not empty: see the same statement in ingest.ts.
           title = COALESCE(EXCLUDED.title, service_links.title),
           confidence = COALESCE(EXCLUDED.confidence, service_links.confidence),
           evidence = CASE WHEN EXCLUDED.evidence = '{}'::jsonb THEN service_links.evidence
                           ELSE EXCLUDED.evidence END,
           method = 'manual', status = 'confirmed', decided_by = EXCLUDED.decided_by, decided_at = now()
         RETURNING id`,
        [
          parsed.data.service_id,
          sourceId,
          document.external_id,
          document.kind ?? 'agreement',
          document.title ?? null,
          parsed.data.confidence ?? null,
          JSON.stringify(parsed.data.evidence ?? {}),
          actor,
        ],
      );

      const entry = `${title} (${SOURCE_SLUG}:${document.external_id})`;
      await query(
        `UPDATE services
            SET data_sources = CASE WHEN $2 = ANY(data_sources) THEN data_sources
                                    ELSE array_append(data_sources, $2) END,
                updated_at = now()
          WHERE id = $1`,
        [parsed.data.service_id, entry],
      );

      res.json({ action, link_id: link[0]?.id, service_id: parsed.data.service_id, status: 'confirmed' });
      return;
    }

    if (!parsed.data.service) {
      res.status(400).json({ error: 'invalid_payload', message: 'service is required to create.' });
      return;
    }

    const result = await createService(parsed.data.service, sourceId, actor);
    res.json({ action, ...result });
  })().catch((err: Error) => {
    console.error('[error] agreements apply:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/* ------------------------------------------------------------------ writing */

interface ServiceInput {
  external_id: string;
  name: string;
  description?: string | null;
  details?: string | null;
  payment_required?: boolean | null;
  payment_details?: string | null;
  phone_numbers?: string[];
  email_address?: string | null;
  urls?: { href: string; title?: string | null }[];
  implements?: string | null;
  source_updated_at?: string | null;
  responses?: string[];
  situations?: string[];
  national_service?: boolean;
  organization?: { id?: string | null; name?: string; kind?: string | null; phone_numbers?: string[] };
  branches?: {
    external_id: string;
    name?: string | null;
    operating_unit?: string | null;
    address?: string | null;
    city?: string | null;
    phone_numbers?: string[];
    email_address?: string | null;
    national_service?: boolean;
  }[];
}

/**
 * Writes one service, in draft, through the same tables and the same audit
 * trail as a push through the write API — including the verbatim payload in
 * raw_records, so a mapping mistake can be found later.
 *
 * Draft, not published: what arrives here has been read out of a PDF by a
 * model, and the last step before the public site should be somebody pressing
 * publish in the review queue.
 */
async function createService(raw: Record<string, unknown>, sourceId: string, actor: string) {
  const input = raw as unknown as ServiceInput;
  if (!input.external_id || !input.name) throw new Error('The service needs an external_id and a name.');

  const serviceId = `${SOURCE_SLUG}:${input.external_id}`;
  const orgName = input.organization?.name ?? 'לא צוין';
  const orgId = input.organization?.id || `${SOURCE_SLUG}:org:${orgName}`;

  const tags = [...(input.responses ?? []), ...(input.situations ?? [])];
  const { rows: known } = await query<{ id: string }>(
    'SELECT id FROM taxonomy_nodes WHERE id = ANY($1::text[]) AND active',
    [tags],
  );
  const knownIds = new Set(known.map((k) => k.id));
  const responses = (input.responses ?? []).filter((t) => knownIds.has(t));
  const situations = (input.situations ?? []).filter((t) => knownIds.has(t));
  const dropped = tags.filter((t) => !knownIds.has(t));
  if (responses.length === 0) {
    throw new Error(`No valid response tag. Given: ${(input.responses ?? []).join(', ') || '(none)'}.`);
  }

  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO ingest_runs (source_id, trigger, status, finished_at, stats)
     VALUES ($1, 'manual', 'success', now(), '{"via":"admin"}'::jsonb) RETURNING id`,
    [sourceId],
  );
  const runId = runRows[0]!.id;

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO raw_records (source_id, ingest_run_id, entity_type, external_id, payload, content_hash)
       VALUES ($1, $2, 'service', $3, $4, $5)`,
      [sourceId, runId, input.external_id, JSON.stringify(raw), contentHash(raw)],
    );

    await client.query(
      `INSERT INTO organizations (id, slug, name, kind, phone_numbers, status, source_id)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = COALESCE(EXCLUDED.kind, organizations.kind),
                                      updated_at = now()`,
      [
        orgId,
        orgId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase(),
        orgName,
        input.organization?.kind ?? null,
        input.organization?.phone_numbers ?? [],
        sourceId,
      ],
    );

    await client.query(
      `INSERT INTO services (id, name, description, details, payment_required, payment_details,
                             urls, phone_numbers, email_address, implements, data_sources,
                             status, source_id, external_ids, source_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, details = EXCLUDED.details,
         payment_required = EXCLUDED.payment_required, payment_details = EXCLUDED.payment_details,
         urls = EXCLUDED.urls, phone_numbers = EXCLUDED.phone_numbers,
         email_address = EXCLUDED.email_address, implements = EXCLUDED.implements,
         updated_at = now()`,
      [
        serviceId,
        input.name,
        input.description ?? null,
        input.details ?? null,
        input.payment_required ?? null,
        input.payment_details ?? null,
        JSON.stringify(input.urls ?? []),
        input.phone_numbers ?? [],
        input.email_address ?? null,
        input.implements ?? null,
        [`נקרא מתוך ${SOURCE_SLUG}:${input.external_id}`],
        sourceId,
        JSON.stringify({ [SOURCE_SLUG]: input.external_id }),
        input.source_updated_at ?? null,
      ],
    );

    await client.query(
      `INSERT INTO service_organizations (service_id, organization_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [serviceId, orgId],
    );

    await client.query(
      `DELETE FROM entity_taxonomy WHERE entity_type = 'service' AND entity_id = $1 AND origin = 'source'`,
      [serviceId],
    );
    for (const [axis, ids] of [
      ['response', responses],
      ['situation', situations],
    ] as const) {
      for (const nodeId of ids) {
        await client.query(
          `INSERT INTO entity_taxonomy (entity_type, entity_id, node_id, axis, origin, actor)
           VALUES ('service', $1, $2, $3::ssil_axis, 'source', $4)
           ON CONFLICT (entity_type, entity_id, node_id) DO NOTHING`,
          [serviceId, nodeId, axis, SOURCE_SLUG],
        );
      }
    }

    for (const branch of input.branches ?? []) {
      const branchId = `${SOURCE_SLUG}:${branch.external_id}`;
      const locationId = `${SOURCE_SLUG}:loc:${branch.external_id}`;
      await client.query(
        `INSERT INTO locations (id, raw_address, provider, accuracy, resolved_address, resolved_city, national_service)
         VALUES ($1, $2, $3, 'unknown', $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET raw_address = EXCLUDED.raw_address,
           resolved_address = EXCLUDED.resolved_address, resolved_city = EXCLUDED.resolved_city,
           national_service = EXCLUDED.national_service`,
        [
          locationId,
          branch.address ?? '',
          `admin:${SOURCE_SLUG}`,
          branch.address ?? null,
          branch.city ?? null,
          branch.national_service ?? input.national_service ?? false,
        ],
      );
      await client.query(
        `INSERT INTO branches (id, organization_id, location_id, name, operating_unit, address,
                               phone_numbers, email_address, status, source_id, external_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, operating_unit = EXCLUDED.operating_unit, address = EXCLUDED.address,
           phone_numbers = EXCLUDED.phone_numbers, email_address = EXCLUDED.email_address, updated_at = now()`,
        [
          branchId,
          orgId,
          locationId,
          branch.name ?? null,
          branch.operating_unit ?? null,
          branch.address ?? null,
          branch.phone_numbers ?? [],
          branch.email_address ?? null,
          sourceId,
          JSON.stringify({ [SOURCE_SLUG]: branch.external_id }),
        ],
      );
      await client.query(
        `INSERT INTO service_branches (service_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [serviceId, branchId],
      );
    }

    await client.query(
      `INSERT INTO change_log (entity_type, entity_id, action, changed, actor, source_id)
       VALUES ('service', $1, 'create', $2, $3, $4)`,
      [serviceId, JSON.stringify({ via: 'agreements screen' }), actor, sourceId],
    );

    // It reaches the public site when a person publishes it, not when a model
    // writes it. The review queue is where that happens.
    await client.query(
      `INSERT INTO moderation_queue (kind, entity_type, entity_id, payload, source_id, submitted_by)
       VALUES ('new_service', 'service', $1, $2, $3, $4)`,
      [serviceId, JSON.stringify(raw), sourceId, actor],
    );
  });

  return {
    service_id: serviceId,
    status: 'draft',
    queued_for_review: true,
    ...(dropped.length ? { dropped_tags: dropped } : {}),
  };
}

async function ensureSource(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO sources (slug, name, kind, trust_level, enabled)
     VALUES ($1, 'הסכמי התקשרות', 'manual', 50, true)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [SOURCE_SLUG],
  );
  return rows[0]!.id;
}

/* ------------------------------------------------------------------ reading */

interface Extraction {
  document: { external_id: string; title?: string | null; kind?: string | null };
  verdict?: { decision?: string; expired?: boolean };
  services?: Record<string, unknown>[];
}

function contentFor(filename: string, base64?: string, text?: string): Anthropic.ContentBlockParam[] {
  if (base64) {
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: `File name: ${filename}` },
    ];
  }
  return [{ type: 'text', text: `File name: ${filename}\n\n${text ?? ''}` }];
}

async function matchOne(service: Record<string, unknown>) {
  const s = service as {
    name?: string;
    alternate_names?: string[];
    organization?: { id?: string | null; name?: string };
    phone_numbers?: string[];
    urls?: ({ href?: string } | string)[];
    responses?: string[];
    national_service?: boolean;
    branches?: { city?: string | null; lat?: number; lon?: number }[];
  };
  if (!s.name) return null;
  const place = (s.branches ?? []).find((b) => b.city || (b.lat != null && b.lon != null));
  return matchService({
    name: s.name,
    alternateNames: s.alternate_names ?? undefined,
    organizationName: s.organization?.name ?? undefined,
    organizationId: s.organization?.id ?? undefined,
    city: place?.city ?? undefined,
    lat: place?.lat,
    lon: place?.lon,
    phoneNumbers: s.phone_numbers ?? undefined,
    urls: (s.urls ?? []).map((u) => (typeof u === 'string' ? u : (u.href ?? ''))).filter(Boolean),
    responses: s.responses ?? undefined,
    nationalService: s.national_service ?? undefined,
  });
}

/**
 * The prompt, with the live taxonomy substituted in and cached briefly.
 *
 * Fetched from the database rather than pasted into the file, because a
 * category list that has drifted from the corpus produces tags the write path
 * then drops — a service that exists and cannot be found.
 */
let cached: { at: number; prompt: string; schema: Record<string, unknown> } | null = null;
const PROMPT_TTL_MS = 10 * 60 * 1000;

async function promptAndSchema(): Promise<{ prompt: string; schema: Record<string, unknown> }> {
  if (cached && Date.now() - cached.at < PROMPT_TTL_MS) return cached;

  const [raw, schemaText] = await Promise.all([readFile(PROMPT_FILE, 'utf8'), readFile(SCHEMA_FILE, 'utf8')]);
  const { rows } = await query<{ id: string; axis: string; depth: number; name: string | null }>(
    `SELECT n.id, n.axis::text AS axis, n.depth, nm.name
       FROM taxonomy_nodes n
       LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = 'he'
      WHERE n.active
      ORDER BY n.axis, n.depth, n.sort_order`,
  );

  const lines = (axis: string) =>
    rows.filter((r) => r.axis === axis).map((r) => `${'  '.repeat(r.depth)}${r.id} — ${r.name ?? ''}`);
  const responses = lines('response');
  const situations = lines('situation');
  const taxonomy = [
    `RESPONSES — what the service provides (${responses.length}):`,
    ...responses,
    '',
    `SITUATIONS — who it is for (${situations.length}):`,
    ...situations,
  ].join('\n');

  const [instructions] = raw.split('\n## The document');
  const prompt = (instructions ?? raw)
    .replaceAll('{{TODAY}}', new Date().toISOString().slice(0, 10))
    .replaceAll('{{TAXONOMY}}', taxonomy)
    .replaceAll('{{SCHEMA}}', schemaText);

  cached = { at: Date.now(), prompt, schema: JSON.parse(schemaText) as Record<string, unknown> };
  return cached;
}

function costOf(model: string, usage: Anthropic.Usage) {
  const price = PRICES[model] ?? PRICES[MODEL]!;
  const perToken = price.input / 1_000_000;
  const input = usage.input_tokens * perToken;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * perToken * CACHE_WRITE_MULTIPLIER;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * perToken * CACHE_READ_MULTIPLIER;
  const output = (usage.output_tokens * price.output) / 1_000_000;
  return {
    currency: 'USD',
    input: round(input),
    cache_write: round(cacheWrite),
    cache_read: round(cacheRead),
    output: round(output),
    total: round(input + cacheWrite + cacheRead + output),
    // What a second document in the same run costs: the prompt is written to
    // the cache once and read cheaply after that, so the first document is not
    // representative of the batch and should not be multiplied by ten thousand.
    marginal: round(input + cacheRead + output + (usage.cache_creation_input_tokens ?? 0) * perToken * CACHE_READ_MULTIPLIER),
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function validate(extraction: Extraction): string[] {
  const warnings: string[] = [];
  for (const raw of extraction.services ?? []) {
    const service = raw as unknown as ServiceInput;
    const where = service.external_id ?? service.name ?? '(ללא שם)';
    if (!service.responses?.length) warnings.push(`${where}: אין תגית שירות — הרשומה לא תהיה ניתנת לאיתור`);
    if (!service.organization?.name) warnings.push(`${where}: לא צוין הגוף המפעיל`);
    if (!service.national_service && !(service.branches ?? []).some((b) => b.city || b.address)) {
      warnings.push(`${where}: אין מקום ואין סימון ארצי — לא ייבנה כרטיס`);
    }
    if (service.organization?.id && !/^\d{8,9}$/.test(String(service.organization.id))) {
      warnings.push(`${where}: "${service.organization.id}" אינו מספר תאגיד תקין`);
    }
  }
  if (extraction.verdict?.decision === 'relevant' && !(extraction.services ?? []).length) {
    warnings.push('ההכרעה היא "רלוונטי" אך לא חולץ שום שירות');
  }
  if (extraction.verdict?.expired) warnings.push('תוקף ההסכם פג');
  return warnings;
}

/** "" becomes null, all the way down; a blank entry in a list is dropped. */
function blankToNull(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (Array.isArray(value)) return value.map(blankToNull).filter((v) => v !== null);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankToNull(v)]));
  }
  return value;
}

function slug(value: string): string {
  return value.replace(/\.[^.]+$/, '').replace(/\s+/g, '-').slice(0, 120) || 'document';
}
