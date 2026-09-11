import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { matchService, query, transaction } from '@ssil/db';
import { contentHash, type JsonSchema } from '@ssil/core';
import {
  apiKeysFromEnv,
  buildReaderPrompt,
  DEFAULT_MODEL,
  effortFor,
  MODELS,
  modelSpec,
  PRICES_CHECKED,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  readAgreement,
  verifyProviders,
  type Effort,
  type Provider,
  type ProviderCheck,
  type ReadResult,
  type ReaderDocument,
} from '@ssil/ingest';
import { requireRole } from '../auth.js';

/**
 * Reading agreements, with any model, and with several at once.
 *
 * The pipeline in scripts/agreements.mjs is what an archive of ten thousand
 * documents goes through. This is the same reading behind a screen, so the
 * questions worth answering before that run can be answered on a handful of
 * real documents: which model understands this kind of document, which one
 * recognises the services we already have, and what each of them costs.
 *
 * A batch is one document sent to every chosen model in parallel. The runs are
 * kept, so answers can be put side by side, and so the totals — cost per
 * document, time, failures, how often a model agreed with the rest — are
 * measured on everything tried rather than remembered.
 *
 * Nothing read here reaches the public site. Acting on a reading (below) makes
 * a draft or a link, one click at a time.
 */
export const agreementsRouter: Router = Router();

agreementsRouter.use(requireRole('editor'));

/**
 * The largest document accepted. Google and OpenAI take PDFs up to 50 MB; an
 * archive is not a document, and a larger file should be split first.
 */
const MAX_BYTES = 50 * 1024 * 1024;

/** How many models one document may be sent to at once. */
const MAX_MODELS_PER_BATCH = 6;

/**
 * Reads running at once against one provider, across every batch. Enough that
 * a comparison does not wait on itself, few enough that three documents
 * dropped on the screen together do not trip a rate limit.
 */
const SLOTS_PER_PROVIDER = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = join(HERE, '..', '..', '..', '..', 'prompts', 'agreement-to-service.md');
const SCHEMA_FILE = join(HERE, '..', '..', '..', '..', 'prompts', 'agreement-extraction.schema.json');

/** The slug everything read here is attributed to. Created on first use. */
const SOURCE_SLUG = 'agreements';

const BOOTED_AT = new Date();

/* ------------------------------------------------------------------ models */

let verified: { at: number; checks: Record<Provider, ProviderCheck> } | null = null;
const VERIFY_TTL_MS = 10 * 60 * 1000;

/**
 * The catalog, and for each model whether it can be used right now: the
 * provider's key is set, and the provider lists the model for that key. The
 * second half is asked of the providers and remembered for ten minutes;
 * `?refresh=1` asks again, which is what to do after setting a key.
 */
agreementsRouter.get('/models', (req, res) => {
  void (async () => {
    const keys = apiKeysFromEnv();
    if (!verified || Date.now() - verified.at > VERIFY_TTL_MS || req.query['refresh'] === '1') {
      verified = { at: Date.now(), checks: await verifyProviders(keys) };
    }
    const checks = verified.checks;

    res.json({
      prices_checked: PRICES_CHECKED,
      default_model: DEFAULT_MODEL,
      max_bytes: MAX_BYTES,
      max_models_per_batch: MAX_MODELS_PER_BATCH,
      checked_at: new Date(verified.at).toISOString(),
      providers: (Object.keys(PROVIDER_LABELS) as Provider[]).map((provider) => ({
        id: provider,
        label: PROVIDER_LABELS[provider],
        key_names: PROVIDER_KEYS[provider],
        ...checks[provider],
      })),
      models: MODELS.map((m) => {
        const check = checks[m.provider];
        const listed = check.listed[m.id];
        return {
          ...m,
          // Usable when the key is set and the provider did not say otherwise.
          // A provider that could not be asked is not held against the model:
          // the read itself will say what is wrong, more precisely than a guess.
          available: check.configured && listed !== false,
          listed: listed ?? null,
        };
      }),
    });
  })().catch((err: Error) => {
    console.error('[error] agreements models:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/** Kept for the checks and for anything that asked before there were models. */
agreementsRouter.get('/status', (_req, res) => {
  const keys = apiKeysFromEnv();
  res.json({
    available: Object.keys(keys).length > 0,
    providers: Object.fromEntries((Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => [p, !!keys[p]])),
    model: DEFAULT_MODEL,
    max_bytes: MAX_BYTES,
  });
});

/* ----------------------------------------------------------------- batches */

const EFFORTS = ['low', 'medium', 'high'] as const;

/**
 * Sends one document to several models at once.
 *
 * The document is the raw request body — a PDF as application/pdf, anything
 * else as text — rather than base64 inside JSON, which inflated a 30 MB scan to
 * 40 MB and was refused before it reached a model. What to read it with is in
 * the query string.
 *
 * Answers 202 at once with the run ids; the reads carry on in the background
 * and each is written to its row as it finishes. The screen polls the batch.
 */
agreementsRouter.post(
  '/batches',
  express.raw({ type: () => true, limit: MAX_BYTES }),
  (req: Request, res: Response) => {
    void (async () => {
      const filename = String(req.query['filename'] ?? '').trim().slice(0, 300);
      const requested = String(req.query['models'] ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      const models = [...new Set(requested)];
      const effort = (EFFORTS as readonly string[]).includes(String(req.query['effort']))
        ? (req.query['effort'] as Effort)
        : 'high';
      const match = req.query['match'] !== 'false';

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const problems: string[] = [];
      if (!filename) problems.push('filename is required.');
      if (body.length === 0) problems.push('The request body is the document, and it was empty.');
      if (models.length === 0) problems.push('Choose at least one model (models=a,b).');
      if (models.length > MAX_MODELS_PER_BATCH) problems.push(`At most ${MAX_MODELS_PER_BATCH} models at once.`);
      const unknown = models.filter((m) => !modelSpec(m));
      if (unknown.length) problems.push(`Not in the catalog: ${unknown.join(', ')}.`);
      if (problems.length) {
        res.status(400).json({ error: 'invalid_request', message: problems.join(' '), problems });
        return;
      }

      // A PDF is recognised by its first bytes, not by what the browser guessed.
      const isPdf = body.subarray(0, 5).toString('latin1') === '%PDF-';
      const document: ReaderDocument = isPdf
        ? { filename, pdf: body }
        : { filename, text: body.toString('utf8') };
      const hash = createHash('sha256').update(body).digest('hex');
      const batchId = randomUUID();
      const actor = req.user?.email ?? 'admin-token';

      const runs: { id: string; model: string; provider: Provider }[] = [];
      for (const model of models) {
        const spec = modelSpec(model)!;
        const { rows } = await query<{ id: string }>(
          `INSERT INTO agreement_runs (batch_id, filename, document_hash, document_bytes, document_kind,
                                       provider, model, effort, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [batchId, filename, hash, body.length, isPdf ? 'pdf' : 'text', spec.provider, model, effortFor(spec, effort), actor],
        );
        runs.push({ id: rows[0]!.id, model, provider: spec.provider });
      }

      res.status(202).json({
        batch_id: batchId,
        filename,
        bytes: body.length,
        kind: isPdf ? 'pdf' : 'text',
        runs: runs.map((r) => ({ id: r.id, model: r.model, status: 'queued' })),
      });

      void runBatch(runs, document, effort, match);
    })().catch((err: Error) => {
      console.error('[error] agreements batch:', err.stack ?? err.message);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
    });
  },
);

agreementsRouter.get('/batches', (req, res) => {
  void (async () => {
    await settleInterrupted();
    const limit = Math.min(Math.max(Number(req.query['limit']) || 30, 1), 200);
    const { rows } = await query(
      `SELECT batch_id, filename,
              max(document_bytes) AS bytes, max(document_kind) AS kind,
              min(created_at) AS created_at, max(finished_at) AS finished_at,
              count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS pending,
              json_agg(json_build_object(
                'id', id, 'model', model, 'provider', provider, 'status', status,
                'decision', extraction->'verdict'->>'decision',
                'services', jsonb_array_length(COALESCE(extraction->'services', '[]'::jsonb)),
                'cost', cost->'total', 'marginal', cost->'marginal', 'elapsed_ms', elapsed_ms,
                'error', error->>'message'
              ) ORDER BY model) AS runs
         FROM agreement_runs
        GROUP BY batch_id, filename
        ORDER BY min(created_at) DESC
        LIMIT $1`,
      [limit],
    );
    res.json({ batches: rows });
  })().catch((err: Error) => {
    console.error('[error] agreements batches:', err.stack ?? err.message);
    res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

agreementsRouter.get('/batches/:id', (req, res) => {
  void (async () => {
    await settleInterrupted();
    const { rows } = await query(
      `SELECT id, batch_id, filename, document_hash, document_bytes, document_kind, provider, model,
              served_model, effort, status, attempts, usage, cost, elapsed_ms, extraction, warnings,
              matches, error, created_by, created_at, started_at, finished_at
         FROM agreement_runs
        WHERE batch_id = $1
        ORDER BY model`,
      [req.params['id']],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ batch_id: req.params['id'], filename: rows[0]!['filename'], runs: rows });
  })().catch((err: Error) => {
    // A malformed uuid is a request that names nothing, not a server fault.
    if (/invalid input syntax for type uuid/.test(err.message)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    console.error('[error] agreements batch:', err.stack ?? err.message);
    res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/** Removes a batch from the history. Nothing written from it is touched. */
agreementsRouter.delete('/batches/:id', (req, res) => {
  void (async () => {
    const { rowCount } = await query(
      `DELETE FROM agreement_runs WHERE batch_id = $1 AND status NOT IN ('queued', 'running')`,
      [req.params['id']],
    );
    res.status(rowCount ? 200 : 404).json({ deleted: rowCount ?? 0 });
  })().catch((err: Error) => {
    if (/invalid input syntax for type uuid/.test(err.message)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/**
 * Per model, across every document tried: what it costs, how long it takes,
 * how often it fails, and how often its verdict agreed with the other models
 * that read the same document.
 *
 * Agreement is not accuracy — three models can agree and all be wrong — but it
 * is the one quality signal that needs no answer key, and a model that is
 * regularly the odd one out is a model whose disagreements are worth reading.
 */
agreementsRouter.get('/stats', (_req, res) => {
  void (async () => {
    await settleInterrupted();
    const { rows: totals } = await query<{
      model: string;
      provider: string;
      runs: number;
      done: number;
      failed: number;
      avg_marginal: number | null;
      avg_total: number | null;
      spent: number | null;
      avg_ms: number | null;
      avg_attempts: number | null;
      avg_bytes: number | null;
    }>(
      `SELECT model, provider,
              count(*)::int AS runs,
              count(*) FILTER (WHERE status = 'done')::int AS done,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              avg((cost->>'marginal')::float8) FILTER (WHERE status = 'done') AS avg_marginal,
              avg((cost->>'total')::float8) FILTER (WHERE status = 'done') AS avg_total,
              sum((cost->>'total')::float8) AS spent,
              avg(elapsed_ms) FILTER (WHERE status = 'done')::float8 AS avg_ms,
              avg(attempts) FILTER (WHERE status = 'done')::float8 AS avg_attempts,
              avg(document_bytes)::float8 AS avg_bytes
         FROM agreement_runs
        WHERE status IN ('done', 'failed')
        GROUP BY model, provider
        ORDER BY model`,
    );

    const { rows: verdicts } = await query<{ batch_id: string; model: string; decision: string | null; services: number }>(
      `SELECT batch_id, model, extraction->'verdict'->>'decision' AS decision,
              jsonb_array_length(COALESCE(extraction->'services', '[]'::jsonb))::int AS services
         FROM agreement_runs
        WHERE status = 'done'`,
    );

    const byBatch = new Map<string, { model: string; decision: string | null; services: number }[]>();
    for (const v of verdicts) byBatch.set(v.batch_id, [...(byBatch.get(v.batch_id) ?? []), v]);

    const agreement = new Map<string, { compared: number; agreed: number }>();
    for (const runs of byBatch.values()) {
      if (runs.length < 2) continue;
      for (const run of runs) {
        // Measured against the others, not against a majority that includes
        // itself: with two models a self-inclusive majority always agrees.
        const others = runs.filter((r) => r !== run).map((r) => r.decision);
        const tally = new Map<string | null, number>();
        for (const d of others) tally.set(d, (tally.get(d) ?? 0) + 1);
        const top = Math.max(...tally.values());
        const entry = agreement.get(run.model) ?? { compared: 0, agreed: 0 };
        entry.compared++;
        if ((tally.get(run.decision) ?? 0) === top) entry.agreed++;
        agreement.set(run.model, entry);
      }
    }

    res.json({
      models: totals.map((t) => ({
        ...t,
        agreement: agreement.get(t.model) ?? { compared: 0, agreed: 0 },
      })),
    });
  })().catch((err: Error) => {
    console.error('[error] agreements stats:', err.stack ?? err.message);
    res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/**
 * Reads one document, synchronously, with one model.
 *
 * The first shape this endpoint had, before batches, kept for callers that want
 * one answer in one response. The screen uses batches.
 */
const AnalyzeSchema = z.object({
  filename: z.string().min(1).max(300),
  /** Base64 for a PDF; plain text for anything else. Exactly one. */
  data_base64: z.string().optional(),
  text: z.string().max(400_000).optional(),
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
  match: z.boolean().optional().describe('Ask the corpus whether each extracted service already exists. Default true.'),
});

agreementsRouter.post('/analyze', (req: Request, res: Response) => {
  void (async () => {
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
    const model = parsed.data.model ?? DEFAULT_MODEL;
    if (!modelSpec(model)) {
      res.status(400).json({ error: 'invalid_payload', message: `Not in the catalog: ${model}.` });
      return;
    }

    const bytes = base64 ? Buffer.byteLength(base64, 'base64') : Buffer.byteLength(text ?? '', 'utf8');
    if (bytes > MAX_BYTES) {
      res.status(413).json({ error: 'too_large', message: `${(bytes / 1e6).toFixed(1)} MB; the limit is ${MAX_BYTES / 1e6} MB.` });
      return;
    }

    const document: ReaderDocument = base64 ? { filename, pdf: Buffer.from(base64, 'base64') } : { filename, text };
    const result = await read(model, document, parsed.data.effort ?? 'high');
    if (!result.ok) {
      const status = result.error?.kind === 'not_configured' ? 503 : result.error?.kind === 'refused' ? 422 : 502;
      res.status(status).json({
        error: result.error?.kind,
        message: result.error?.message,
        problems: result.error?.problems,
        answer: result.error?.answer?.slice(0, 500),
        cost: result.cost,
      });
      return;
    }

    const extraction = finish(result.extraction!, filename);
    const matches = parsed.data.match === false ? [] : await matchAll(extraction);
    res.json({
      filename,
      model: result.servedModel ?? model,
      effort: result.effort,
      elapsed_ms: result.elapsedMs,
      attempts: result.attempts,
      usage: {
        input: result.usage.input,
        output: result.usage.output,
        cache_read: result.usage.cacheRead,
        cache_write: result.usage.cacheWrite,
        reasoning: result.usage.reasoning,
      },
      cost: result.cost,
      extraction,
      warnings: validate(extraction),
      matches,
    });
  })().catch((err: Error) => {
    console.error('[error] agreements analyze:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: err.message });
  });
});

/* -------------------------------------------------------------- the reading */

async function runBatch(
  runs: { id: string; model: string; provider: Provider }[],
  document: ReaderDocument,
  effort: Effort,
  match: boolean,
): Promise<void> {
  await Promise.all(
    runs.map((run) =>
      withSlot(run.provider, async () => {
        await query(`UPDATE agreement_runs SET status = 'running', started_at = now() WHERE id = $1`, [run.id]);
        try {
          const result = await read(run.model, document, effort);
          await record(run.id, result, document.filename, match);
        } catch (err) {
          // readAgreement does not throw for anything a provider does; this is
          // the database, or a bug, and the row must still stop saying running.
          console.error(`[error] agreements run ${run.id}:`, (err as Error).stack ?? (err as Error).message);
          await query(
            `UPDATE agreement_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
            [run.id, JSON.stringify({ kind: 'internal', message: (err as Error).message })],
          ).catch(() => undefined);
        }
      }),
    ),
  );
}

async function read(model: string, document: ReaderDocument, effort: Effort): Promise<ReadResult> {
  const { prompt, schema } = await promptAndSchema();
  return readAgreement({
    modelId: model,
    effort,
    system: prompt,
    schema: schema as JsonSchema,
    document,
    apiKeys: apiKeysFromEnv(),
  });
}

async function record(runId: string, result: ReadResult, filename: string, match: boolean): Promise<void> {
  const usage = {
    input: result.usage.input,
    output: result.usage.output,
    cache_read: result.usage.cacheRead,
    cache_write: result.usage.cacheWrite,
    reasoning: result.usage.reasoning,
  };

  if (!result.ok) {
    await query(
      `UPDATE agreement_runs
          SET status = 'failed', finished_at = now(), attempts = $2, usage = $3, cost = $4,
              elapsed_ms = $5, served_model = $6, error = $7
        WHERE id = $1`,
      [runId, result.attempts, usage, result.cost ?? {}, result.elapsedMs, result.servedModel, JSON.stringify(result.error)],
    );
    return;
  }

  const extraction = finish(result.extraction!, filename);
  const matches = match ? await matchAll(extraction).catch(() => null) : null;
  await query(
    `UPDATE agreement_runs
        SET status = 'done', finished_at = now(), attempts = $2, usage = $3, cost = $4,
            elapsed_ms = $5, served_model = $6, extraction = $7, warnings = $8, matches = $9
      WHERE id = $1`,
    [
      runId,
      result.attempts,
      usage,
      result.cost ?? {},
      result.elapsedMs,
      result.servedModel,
      JSON.stringify(extraction),
      JSON.stringify(validate(extraction)),
      matches === null ? null : JSON.stringify(matches),
    ],
  );
}

/**
 * Runs left 'queued' or 'running' by a server that has since restarted will
 * never finish: their reads lived in that process's memory. They are marked as
 * failed, once, the first time anyone looks after boot.
 */
let settled = false;
async function settleInterrupted(): Promise<void> {
  if (settled) return;
  await query(
    `UPDATE agreement_runs
        SET status = 'failed', finished_at = now(),
            error = '{"kind":"internal","message":"Interrupted by a server restart before it finished."}'::jsonb
      WHERE status IN ('queued', 'running') AND created_at < $1`,
    [BOOTED_AT],
  );
  settled = true;
}

const active: Record<Provider, number> = { anthropic: 0, openai: 0, google: 0 };
const waiting: Record<Provider, (() => void)[]> = { anthropic: [], openai: [], google: [] };

async function withSlot<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
  while (active[provider] >= SLOTS_PER_PROVIDER) {
    await new Promise<void>((resolve) => waiting[provider].push(resolve));
  }
  active[provider]++;
  try {
    return await fn();
  } finally {
    active[provider]--;
    waiting[provider].shift()?.();
  }
}

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

/**
 * The ids a write needs, where the model left them out. The document's own id
 * is what makes a second reading update rather than duplicate; the file name is
 * a worse id, but a deterministic one.
 */
function finish(raw: Record<string, unknown>, filename: string): Extraction {
  const extraction = raw as unknown as Extraction;
  extraction.document ??= {} as Extraction['document'];
  extraction.document.external_id ||= slug(filename);
  (extraction.services ?? []).forEach((service, i) => {
    service['external_id'] ||= `${extraction.document.external_id}-${i + 1}`;
  });
  return extraction;
}

function matchAll(extraction: Extraction) {
  return Promise.all((extraction.services ?? []).map((service) => matchOne(service)));
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
 * then drops — a service that exists and cannot be found. The same prompt goes
 * to every model, which is what makes their answers comparable.
 */
let cached: { at: number; prompt: string; schema: Record<string, unknown> } | null = null;
let pending: Promise<{ at: number; prompt: string; schema: Record<string, unknown> }> | null = null;
const PROMPT_TTL_MS = 10 * 60 * 1000;

async function promptAndSchema(): Promise<{ prompt: string; schema: Record<string, unknown> }> {
  if (cached && Date.now() - cached.at < PROMPT_TTL_MS) return cached;
  // Six models starting at once should build the prompt once, not six times —
  // and should all send the same bytes, or the providers' caches never meet.
  pending ??= (async () => {
    const [template, schemaText] = await Promise.all([readFile(PROMPT_FILE, 'utf8'), readFile(SCHEMA_FILE, 'utf8')]);
    const { rows } = await query<{ id: string; axis: string; depth: number; name: string | null }>(
      `SELECT n.id, n.axis::text AS axis, n.depth, nm.name
         FROM taxonomy_nodes n
         LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = 'he'
        WHERE n.active
        ORDER BY n.axis, n.depth, n.sort_order`,
    );
    const prompt = buildReaderPrompt({
      template,
      schemaText,
      nodes: rows,
      today: new Date().toISOString().slice(0, 10),
    });
    return { at: Date.now(), prompt, schema: JSON.parse(schemaText) as Record<string, unknown> };
  })();
  try {
    cached = await pending;
    return cached;
  } finally {
    pending = null;
  }
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

function slug(value: string): string {
  return value.replace(/\.[^.]+$/, '').replace(/\s+/g, '-').slice(0, 120) || 'document';
}
