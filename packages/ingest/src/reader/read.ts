import { parseJsonObject, schemaErrors, type JsonSchema } from '@ssil/core';
import { openAnthropic } from './anthropic.js';
import { openGoogle } from './google.js';
import {
  addUsage,
  costOf,
  effortFor,
  emptyUsage,
  modelSpec,
  PROVIDER_KEYS,
  type Cost,
  type Effort,
  type Provider,
  type Usage,
} from './models.js';
import { openOpenAI } from './openai.js';
import { ReaderError, type ReaderDocument, type ReaderSession, type SessionOptions } from './types.js';

/**
 * Reading one agreement with one model.
 *
 * The same loop whichever provider answers: send the document, check the reply
 * against the schema, and if it does not validate, send it back once with the
 * errors. Holding every model to the same prompt, the same validator and the
 * same single correction is what makes their answers comparable at all — a
 * model that needed the correction is visibly a model that needed it, in
 * `attempts` and in the bill.
 *
 * It does not throw for anything a provider does. A missing key, a refusal, a
 * reply that never validates: each comes back as a result with `ok: false`,
 * carrying whatever was spent getting there, because a comparison that loses
 * the failed runs loses exactly the runs it most needs to show.
 */

export interface ReadOptions {
  modelId: string;
  effort?: Effort | undefined;
  system: string;
  schema: JsonSchema;
  document: ReaderDocument;
  apiKeys: Partial<Record<Provider, string>>;
  maxAttempts?: number | undefined;
  maxOutputTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ReadFailure {
  kind: ReaderError['kind'] | 'refused' | 'invalid_answer' | 'internal';
  message: string;
  problems?: string[] | undefined;
  answer?: string | undefined;
}

export interface ReadResult {
  model: string;
  provider: Provider | null;
  servedModel: string | null;
  effort: Effort | null;
  ok: boolean;
  /** The validated answer, with "" turned into null. */
  extraction: Record<string, unknown> | null;
  attempts: number;
  usage: Usage;
  cost: Cost | null;
  elapsedMs: number;
  error?: ReadFailure | undefined;
}

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_MAX_OUTPUT = 32_000;

const OPENERS: Record<Provider, (options: SessionOptions) => Promise<ReaderSession>> = {
  anthropic: openAnthropic,
  openai: openOpenAI,
  google: openGoogle,
};

export async function readAgreement(options: ReadOptions): Promise<ReadResult> {
  const started = Date.now();
  const spec = modelSpec(options.modelId);
  const usage = emptyUsage();

  const fail = (error: ReadFailure, attempts = 0, servedModel: string | null = null): ReadResult => ({
    model: options.modelId,
    provider: spec?.provider ?? null,
    servedModel,
    effort: spec ? effortFor(spec, options.effort ?? 'high') : null,
    ok: false,
    extraction: null,
    attempts,
    usage,
    cost: spec ? costOf(spec, usage) : null,
    elapsedMs: Date.now() - started,
    error,
  });

  if (!spec) return fail({ kind: 'unknown_model', message: `No model called ${options.modelId} in the catalog.` });

  const apiKey = options.apiKeys[spec.provider];
  if (!apiKey) {
    return fail({
      kind: 'not_configured',
      message: `${PROVIDER_KEYS[spec.provider].join(' or ')} is not set on this server.`,
    });
  }

  const effort = effortFor(spec, options.effort ?? 'high');
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
  let session: ReaderSession | null = null;
  let attempts = 0;
  let servedModel: string | null = null;
  let problems: string[] = [];
  let answer = '';

  try {
    session = await OPENERS[spec.provider]({
      spec,
      system: options.system,
      document: options.document,
      effort,
      apiKey,
      maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      signal: options.signal,
    });

    let correction: string | undefined;
    while (attempts < maxAttempts) {
      attempts++;
      const reply = await session.turn(correction);
      addUsage(usage, reply.usage);
      servedModel = reply.servedModel;
      answer = reply.text;

      if (reply.stop === 'refused') {
        return fail(
          { kind: 'refused', message: `The model declined this document (${reply.detail ?? 'no reason given'}).` },
          attempts,
          servedModel,
        );
      }

      const parsed = parseJsonObject(answer);
      problems = parsed.ok ? schemaErrors(options.schema, parsed.value) : [parsed.error];
      if (reply.stop === 'max_tokens') problems.unshift('The reply was cut off at the output limit.');

      if (parsed.ok && problems.length === 0) {
        return {
          model: spec.id,
          provider: spec.provider,
          servedModel,
          effort,
          ok: true,
          extraction: blankToNull(parsed.value) as Record<string, unknown>,
          attempts,
          usage,
          cost: costOf(spec, usage),
          elapsedMs: Date.now() - started,
        };
      }

      correction = [
        'That reply does not match the schema:',
        ...problems.slice(0, 20).map((p) => `- ${p}`),
        '',
        'Reply with the corrected JSON object only.',
      ].join('\n');
    }

    return fail(
      {
        kind: 'invalid_answer',
        message: `No valid answer after ${attempts} attempt(s).`,
        problems: problems.slice(0, 20),
        answer: answer.slice(0, 1000),
      },
      attempts,
      servedModel,
    );
  } catch (err) {
    if (err instanceof ReaderError) return fail({ kind: err.kind, message: err.message }, attempts, servedModel);
    if ((err as Error).name === 'AbortError') return fail({ kind: 'network', message: 'The read was cancelled.' }, attempts, servedModel);
    return fail({ kind: 'internal', message: (err as Error).message ?? String(err) }, attempts, servedModel);
  } finally {
    await session?.close();
  }
}

/** Keys from the environment, under every name each provider is known by. */
export function apiKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<Provider, string>> {
  const keys: Partial<Record<Provider, string>> = {};
  for (const [provider, names] of Object.entries(PROVIDER_KEYS) as [Provider, string[]][]) {
    const value = names.map((name) => env[name]).find((v) => v && v.trim());
    if (value) keys[provider] = value.trim();
  }
  return keys;
}

/** "" becomes null, all the way down; a blank entry in a list is dropped. */
export function blankToNull(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (Array.isArray(value)) return value.map(blankToNull).filter((v) => v !== null);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankToNull(v)]));
  }
  return value;
}
