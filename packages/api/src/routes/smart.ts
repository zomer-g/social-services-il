import Anthropic from '@anthropic-ai/sdk';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query } from '@ssil/db';
import { config } from '../config.js';
import { CORPUS_INSTRUCTIONS, sharedTools, toolsByName } from '../tools.js';

/**
 * Smart search.
 *
 * The ordinary search box needs the right words. This one takes a sentence —
 * "אין לי כסף לאוכל ואני בתל אביב" — and works out which categories it means
 * before searching, which is the step the person is currently expected to do in
 * their head.
 *
 * It runs on exactly the tools the MCP server exposes, called server-side: the
 * browser cannot speak MCP, and an API key must never reach it. So the same
 * operations an assistant would perform over MCP are performed here on the
 * visitor's behalf, and the answer comes back with the real service cards
 * attached rather than as prose about them.
 *
 * Two things it deliberately does not do. It does not invent services: every
 * card shown is one the tools returned, looked up again from the database by id.
 * And it does not replace the plain search — an LLM in the path of someone in
 * distress is a dependency, so the ordinary box stays, always works, and stays
 * first.
 */
export const smartRouter: Router = Router();

const MODEL = 'claude-opus-5';

/**
 * A public endpoint that costs money per call needs a ceiling. Held in memory
 * rather than the database: it is a throttle, not an audit trail, and losing it
 * on restart is fine.
 */
const RATE_LIMIT_PER_HOUR = 20;
const buckets = new Map<string, { count: number; resetAt: number }>();

function overLimit(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 3600_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_HOUR;
}

// The map would otherwise grow without bound behind a proxy.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
}, 600_000).unref();

const RequestSchema = z.object({
  q: z.string().min(2).max(500),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  lang: z.enum(['he', 'ar', 'ru', 'en']).default('he'),
});

const SYSTEM = [
  CORPUS_INSTRUCTIONS,
  '',
  'You are helping someone find social services in Israel. They have typed a sentence about',
  'their situation rather than a category name.',
  '',
  'Work like this:',
  '1. If the message suggests immediate danger — violence, self-harm, a child at risk — call',
  '   emergency_lines first and put those numbers at the top of your answer.',
  '2. Use find_taxonomy to turn what they described into response and situation ids. Prefer ids',
  '   with a high card_count; a category with none is a dead end.',
  '3. Call search_services with those ids, and with the location if one was given.',
  '4. If the first search returns nothing, broaden: drop the situation filter, or move up to a',
  '   parent category. Do not give up after one attempt.',
  '',
  'Then reply with a short paragraph — three sentences at most — in the language the person',
  'wrote in. Say what you understood them to need and what you found. Do not list the services:',
  'they are shown to the person as cards underneath your answer, so listing them repeats what',
  'they can already see. Do not invent a service, a phone number or an address; everything shown',
  'comes from the tools. If the corpus has little for this need, say so plainly.',
  '',
  'Write plainly, the way you would speak to someone who is tired and worried. No bureaucratic',
  'register, no bullet points, no headings.',
].join('\n');

/** Zod shapes are what MCP wants; the Messages API wants JSON Schema. */
const anthropicTools: Anthropic.Tool[] = sharedTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: z.toJSONSchema(z.object(tool.schema)) as Anthropic.Tool.InputSchema,
}));

interface Interpretation {
  responses: { id: string; name: string }[];
  situations: { id: string; name: string }[];
  city?: string;
}

smartRouter.post('/smart-search', (req: Request, res: Response) => {
  void handle(req, res).catch((err: Error) => {
    console.error('[error] smart search:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

async function handle(req: Request, res: Response): Promise<void> {
  if (!config.anthropicApiKey) {
    res.status(503).json({
      error: 'smart_search_unavailable',
      message: 'החיפוש החכם אינו מוגדר בשרת. יש להגדיר ANTHROPIC_API_KEY.',
    });
    return;
  }

  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', message: 'q is required (2–500 characters)' });
    return;
  }

  const key = req.ip ?? 'unknown';
  if (overLimit(key)) {
    res.status(429).json({
      error: 'rate_limited',
      message: 'יותר מדי חיפושים חכמים בשעה האחרונה. אפשר להשתמש בחיפוש הרגיל.',
    });
    return;
  }

  const { q, lat, lon, lang } = parsed.data;
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        lat !== undefined && lon !== undefined
          ? `${q}\n\n(The person's location is lat ${lat}, lon ${lon}. Pass it to the search.)`
          : q,
    },
  ];

  const cardIds: string[] = [];
  const interpretation: Interpretation = { responses: [], situations: [] };
  const calls: string[] = [];
  let answer = '';

  // A bounded loop rather than an open-ended agent: this is a routing task, and
  // a public endpoint should not be able to spend unboundedly on one question.
  for (let turn = 0; turn < 6; turn += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      // Low effort deliberately: the task is to pick categories and run a
      // search, and someone waiting on a search page feels every second.
      output_config: { effort: 'low' },
      system: SYSTEM,
      tools: anthropicTools,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      res.status(422).json({
        error: 'declined',
        message: 'לא הצלחנו לעבד את הבקשה הזו. אפשר לנסות לנסח אחרת או להשתמש בחיפוש הרגיל.',
      });
      return;
    }

    for (const block of response.content) {
      if (block.type === 'text') answer += block.text;
    }

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      calls.push(block.name);
      const tool = toolsByName.get(block.name);
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Unknown tool', is_error: true });
        continue;
      }
      try {
        const out = await tool.handler((block.input ?? {}) as Record<string, unknown>);
        collect(out, block.name, block.input, cardIds, interpretation);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: (err as Error).message,
          is_error: true,
        });
      }
    }

    // All results in one user message: splitting them teaches the model to stop
    // making parallel calls.
    messages.push({ role: 'user', content: results });
  }

  // Cards are re-read from the database by id rather than taken from the
  // model's output. Nothing reaches the page that is not a real record.
  const cards = await loadCards(cardIds.slice(0, 20), lang, lat, lon);

  void query(
    `INSERT INTO search_events (query, normalized, response_ids, situation_ids, has_location, lang, result_count)
     VALUES ($1, ssil_normalize($1), $2, $3, $4, $5, $6)`,
    [
      q,
      interpretation.responses.map((r) => r.id),
      interpretation.situations.map((s) => s.id),
      lat !== undefined,
      lang,
      cards.length,
    ],
  ).catch(() => {});

  res.json({
    answer: answer.trim(),
    understood: interpretation,
    cards,
    tools_used: [...new Set(calls)],
  });
}

/**
 * Pulls the card ids and the categories out of whatever the tools returned, so
 * the page can show real cards and tell the person what was understood.
 */
function collect(
  out: unknown,
  toolName: string,
  input: unknown,
  cardIds: string[],
  interpretation: Interpretation,
): void {
  const record = out as Record<string, unknown>;

  for (const list of [record['services'], record['nearby'], record['also_available_nationwide']]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = (item as { card_id?: string }).card_id;
      if (id && !cardIds.includes(id)) cardIds.push(id);
    }
  }

  // Which categories the search actually ran on — taken from the arguments the
  // model passed, not from its prose, so the chips cannot misreport it.
  if (toolName === 'search_services' && input && typeof input === 'object') {
    const args = input as { response_ids?: string[]; situation_ids?: string[]; city?: string };
    if (args.city) interpretation.city = args.city;
    for (const [ids, target] of [
      [args.response_ids, interpretation.responses],
      [args.situation_ids, interpretation.situations],
    ] as const) {
      for (const id of ids ?? []) {
        if (!target.some((t) => t.id === id)) target.push({ id, name: id });
      }
    }
  }
}

async function loadCards(
  ids: string[],
  lang: string,
  lat?: number,
  lon?: number,
): Promise<unknown[]> {
  if (ids.length === 0) return [];
  const { rows } = await query(
    `SELECT c.card_id, c.service_id, c.branch_id, c.organization_id,
            c.service_name, c.service_description,
            c.organization_name, c.organization_short_name, c.organization_kind,
            c.branch_name, c.address, c.city,
            ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon,
            c.national_service, c.location_accurate, c.phone_numbers,
            c.response_ids, c.situation_ids, c.score, c.updated_at,
            0 AS also_available_at, 0 AS other_organizations,
            CASE WHEN $2::float8 IS NOT NULL AND c.geom IS NOT NULL
                 THEN round(ST_Distance(c.geom, ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography))::int
            END AS distance_m
       FROM cards c
       JOIN unnest($1::text[]) WITH ORDINALITY AS o(id, ord) ON o.id = c.card_id
      ORDER BY o.ord`,
    [ids, lon ?? null, lat ?? null],
  );
  void lang;
  return rows;
}

/** Lets the front end hide the button rather than offer something that 503s. */
smartRouter.get('/smart-search/status', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300').json({ available: Boolean(config.anthropicApiKey) });
});
