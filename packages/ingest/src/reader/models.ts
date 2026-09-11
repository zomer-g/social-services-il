/**
 * The models an agreement can be read with, and what each costs.
 *
 * One list, used by the screen, the batch script and the cost arithmetic, so a
 * price changed here is changed everywhere it is shown or charged.
 *
 * Prices are USD per million tokens as the providers published them in
 * September 2026, and they are the only thing in this file that goes stale by
 * itself. `checked` says when they were last read off the providers' pages; the
 * screen shows it next to every figure it derives from them.
 *
 * The three providers do not charge for the same things in the same way, and
 * the differences matter more than the headline rates:
 *
 *   - Anthropic caches the prompt on request, charges a quarter more to write
 *     the cache and a tenth to read it.
 *   - OpenAI caches automatically. From GPT-5.6 a write costs a quarter more,
 *     as at Anthropic; earlier models charge a write as ordinary input.
 *   - Google caches implicitly and does not charge for the write, and Gemini
 *     3.1 Pro doubles its input price once a prompt passes 200k tokens.
 *
 * And, for scanned documents, the difference that dwarfs all of those: Gemini
 * bills a PDF page at a flat 560 tokens, where the other two bill the page as
 * an image at a resolution they choose.
 */

export type Provider = 'anthropic' | 'openai' | 'google';

/** How hard the model thinks. Mapped onto each provider's own parameter. */
export type Effort = 'low' | 'medium' | 'high';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/** The environment variable each provider's key is read from. */
export const PROVIDER_KEYS: Record<Provider, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

export interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelSpec {
  id: string;
  provider: Provider;
  label: string;
  /** Where it sits in its provider's range, for grouping on the screen. */
  tier: 'flagship' | 'balanced' | 'economy';
  prices: Prices;
  /** Gemini 3.1 Pro charges more for a prompt past a threshold. */
  longContext?: { aboveTokens: number; prices: Prices } | undefined;
  /**
   * The effort levels the model accepts, in order. Empty for a model that has
   * no such control; a requested level is moved to the nearest one it has.
   */
  efforts: Effort[];
  /** Something about the price that a reader of a projection needs to know. */
  note?: string | undefined;
}

export const PRICES_CHECKED = '2026-09-11';

export const MODELS: ModelSpec[] = [
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    tier: 'flagship',
    prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    tier: 'balanced',
    prices: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    tier: 'economy',
    prices: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    // Haiku 4.5 predates the effort control and rejects it.
    efforts: [],
  },
  {
    id: 'gpt-5.6-sol',
    provider: 'openai',
    label: 'GPT-5.6 Sol',
    tier: 'flagship',
    prices: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    label: 'GPT-5.6 Terra',
    tier: 'balanced',
    prices: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    label: 'GPT-5.4 mini',
    tier: 'economy',
    prices: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    label: 'GPT-5.6 Luna',
    tier: 'economy',
    prices: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    label: 'Gemini 3.1 Pro',
    tier: 'flagship',
    prices: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
    longContext: { aboveTokens: 200_000, prices: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 4 } },
    efforts: ['low', 'high'],
    note: 'Preview model; input doubles above 200k tokens.',
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'google',
    label: 'Gemini 3.8 Flash',
    tier: 'balanced',
    prices: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
    efforts: ['low', 'medium', 'high'],
    note: 'Introductory price until 2026-12-31, then $1.50 / $7.50.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    label: 'Gemini 3.5 Flash-Lite',
    tier: 'economy',
    prices: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
    efforts: ['low', 'medium', 'high'],
  },
];

export const DEFAULT_MODEL = 'claude-opus-5';

export function modelSpec(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The level a model will actually run at when `requested` is asked for. */
export function effortFor(spec: ModelSpec, requested: Effort): Effort | null {
  if (spec.efforts.length === 0) return null;
  if (spec.efforts.includes(requested)) return requested;
  const order: Effort[] = ['low', 'medium', 'high'];
  const want = order.indexOf(requested);
  // Up rather than down on a tie: a comparison that silently thinks less than
  // it was asked to would be measuring the wrong thing.
  return [...spec.efforts].sort(
    (a, b) => Math.abs(order.indexOf(a) - want) - Math.abs(order.indexOf(b) - want) || order.indexOf(b) - order.indexOf(a),
  )[0]!;
}

/** Token counts, normalised across providers. */
export interface Usage {
  /** Input billed at the ordinary rate. */
  input: number;
  /** Input read from a cache. */
  cacheRead: number;
  /** Input written to a cache. Zero where the provider does not report or charge it. */
  cacheWrite: number;
  /** Everything generated, reasoning included. */
  output: number;
  /** The part of `output` that was reasoning, where the provider reports it. */
  reasoning: number | null;
  /** The largest single prompt sent, which is what a long-context price keys on. */
  largestPrompt: number;
}

export function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: null, largestPrompt: 0 };
}

export function addUsage(into: Usage, more: Usage): Usage {
  into.input += more.input;
  into.cacheRead += more.cacheRead;
  into.cacheWrite += more.cacheWrite;
  into.output += more.output;
  into.reasoning = more.reasoning === null ? into.reasoning : (into.reasoning ?? 0) + more.reasoning;
  into.largestPrompt = Math.max(into.largestPrompt, more.largestPrompt);
  return into;
}

export interface Cost {
  currency: 'USD';
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  total: number;
  /**
   * What the next document in the same run costs: the prompt written to the
   * cache once is read cheaply after that, so the first document overstates
   * the batch, and multiplying it by ten thousand would overstate it with it.
   */
  marginal: number;
}

export function costOf(spec: ModelSpec, usage: Usage): Cost {
  const prices =
    spec.longContext && usage.largestPrompt > spec.longContext.aboveTokens ? spec.longContext.prices : spec.prices;
  const per = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
  const input = per(usage.input, prices.input);
  const cacheWrite = per(usage.cacheWrite, prices.cacheWrite);
  const cacheRead = per(usage.cacheRead, prices.cacheRead);
  const output = per(usage.output, prices.output);
  return {
    currency: 'USD',
    input: round(input),
    cache_write: round(cacheWrite),
    cache_read: round(cacheRead),
    output: round(output),
    total: round(input + cacheWrite + cacheRead + output),
    marginal: round(input + cacheRead + output + per(usage.cacheWrite, prices.cacheRead)),
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
