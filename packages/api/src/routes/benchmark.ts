import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, searchCards } from '@ssil/db';
import { requireRole } from '../auth.js';
import { config } from '../config.js';
import { runSmartSearch, smartAvailable } from './smart.js';

/**
 * The benchmark: a fixed list of queries put to every search interface the
 * site has, with what came back kept in order.
 *
 * The three modes are the three doors on the home page:
 *   quick — the search box, GET /api/v1/search
 *   smart — the "חיפוש חכם" button, the model picking categories (format brief)
 *   free  — the "כתבו במילים שלכם" box, the model writing an answer (format prose)
 *
 * Each is called as a function rather than over HTTP, so the benchmark is not
 * throttled by the per-address limit on the public smart search and does not
 * fill the search log with the team's own queries.
 *
 * A run is processed in the background, one cell (query × mode) at a time, and
 * every cell is written as it finishes. A restart loses at most the cells in
 * flight; the run resumes from the next one.
 */
export const benchmarkRouter: Router = Router();

benchmarkRouter.use(requireRole('editor'));

export const MODES = ['quick', 'smart', 'free'] as const;
type Mode = (typeof MODES)[number];

/** How many results quick search keeps per query: its own maximum page. */
const QUICK_LIMIT = 100;
/**
 * Cells in flight at once. The model modes take seconds each, so one at a time
 * makes sixty queries an hour's wait; more than a few and a run competes with
 * the public smart search for the same API key.
 */
const CONCURRENCY = 3;

interface Hit {
  card_id: string;
  service_id: string;
  service_name: string;
  organization_name: string;
  branch_name: string | null;
  city: string | null;
}

interface QueryItem {
  query: string;
  expected: string[];
}

interface RunRow {
  id: string;
  name: string;
  lang: string;
  modes: Mode[];
  queries: QueryItem[];
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  error: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface CellRow {
  query_no: number;
  mode: Mode;
  hits: Hit[];
  total: number | null;
  answer: string | null;
  duration_ms: number | null;
  error: string | null;
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      console.error('[error] benchmark handler:', err.stack ?? err.message);
      res.status(500).json({ error: 'internal_error', message: err.message });
    });
  };
}

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  lang: z.enum(['he', 'ar', 'ru', 'en']).default('he'),
  modes: z.array(z.enum(MODES)).min(1),
  queries: z
    .array(
      z.object({
        query: z.string().trim().min(2).max(500),
        expected: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
      }),
    )
    .min(1)
    .max(500),
});

benchmarkRouter.post(
  '/',
  handle(async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'bad_request',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return;
    }
    const id = await createRun(parsed.data, req.user?.email ?? null);
    kickBenchmarks();
    res.status(201).json({ id });
  }),
);

async function createRun(
  input: { name: string; lang: string; modes: Mode[]; queries: QueryItem[] },
  createdBy: string | null,
): Promise<string> {
  // In the order of the home page, whatever order they were ticked in.
  const modes = MODES.filter((m) => input.modes.includes(m));
  const { rows } = await query<{ id: string }>(
    `INSERT INTO benchmark_runs (name, lang, modes, queries, total, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.name, input.lang, modes, JSON.stringify(input.queries), input.queries.length * modes.length, createdBy],
  );
  return rows[0]!.id;
}

benchmarkRouter.get(
  '/',
  handle(async (_req, res) => {
    const { rows } = await query(
      `SELECT r.id, r.name, r.lang, r.modes, r.status, r.total, r.error, r.created_by,
              r.created_at, r.started_at, r.finished_at,
              jsonb_array_length(r.queries)::int AS queries,
              (SELECT count(*)::int FROM benchmark_cells c WHERE c.run_id = r.id) AS done
         FROM benchmark_runs r
        ORDER BY r.created_at DESC
        LIMIT 100`,
    );
    res.json({ runs: rows, smart_available: smartAvailable() });
  }),
);

/**
 * One run: its settings, a summary per mode, and every query with each mode's
 * rank for the expected answer and the first few results. The full lists are
 * in the CSV; this is what fits on a screen.
 */
benchmarkRouter.get(
  '/:id',
  handle(async (req, res) => {
    const run = await loadRun(String(req.params['id']));
    if (!run) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const cells = await loadCells(run.id);
    const byKey = new Map(cells.map((c) => [`${c.query_no}:${c.mode}`, c]));

    const rows = run.queries.map((item, i) => ({
      query_no: i + 1,
      query: item.query,
      expected: item.expected,
      cells: Object.fromEntries(
        run.modes.map((mode) => {
          const cell = byKey.get(`${i + 1}:${mode}`);
          if (!cell) return [mode, null];
          return [
            mode,
            {
              rank: rankOf(cell.hits, item.expected),
              count: cell.hits.length,
              total: cell.total,
              top: cell.hits.slice(0, 5),
              answer: cell.answer,
              error: cell.error,
              duration_ms: cell.duration_ms,
            },
          ];
        }),
      ),
    }));

    res.json({ run: { ...run, done: cells.length }, summary: summarise(run, byKey), rows });
  }),
);

/**
 * Long format: one line per result, so a spreadsheet can filter by query or
 * mode and pivot on rank. A cell with no results still gets a line, so a query
 * that found nothing is visible rather than missing.
 */
benchmarkRouter.get(
  '/:id/export.csv',
  handle(async (req, res) => {
    const run = await loadRun(String(req.params['id']));
    if (!run) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const cells = await loadCells(run.id);
    const byKey = new Map(cells.map((c) => [`${c.query_no}:${c.mode}`, c]));

    const lines: string[][] = [
      [
        'run', 'query_no', 'query', 'expected', 'mode', 'rank', 'card_id', 'service_id', 'service_name',
        'organization_name', 'branch_name', 'city', 'is_expected', 'expected_rank', 'results_kept',
        'total_reported', 'duration_ms', 'error', 'answer',
      ],
    ];

    run.queries.forEach((item, i) => {
      for (const mode of run.modes) {
        const cell = byKey.get(`${i + 1}:${mode}`);
        const expected = item.expected.join(' | ');
        const prefix = [run.name, String(i + 1), item.query, expected, mode];
        if (!cell) {
          lines.push([...prefix, '', '', '', '', '', '', '', '', '', '', '', '', 'not run yet', '']);
          continue;
        }
        const expectedRank = rankOf(cell.hits, item.expected);
        const tail = (first: boolean) => [
          expectedRank === null ? '' : String(expectedRank),
          String(cell.hits.length),
          cell.total === null ? '' : String(cell.total),
          cell.duration_ms === null ? '' : String(cell.duration_ms),
          cell.error ?? '',
          // Once per cell: the answer belongs to the query, not to each result.
          first ? (cell.answer ?? '') : '',
        ];
        if (cell.hits.length === 0) {
          lines.push([...prefix, '', '', '', '', '', '', '', '', ...tail(true)]);
          continue;
        }
        cell.hits.forEach((hit, r) => {
          lines.push([
            ...prefix,
            String(r + 1),
            hit.card_id,
            hit.service_id,
            hit.service_name,
            hit.organization_name,
            hit.branch_name ?? '',
            hit.city ?? '',
            item.expected.length === 0 ? '' : isExpected(hit, item.expected) ? '1' : '0',
            ...tail(r === 0),
          ]);
        });
      }
    });

    // The byte-order mark is what makes Excel read the Hebrew as Hebrew.
    const body = '﻿' + lines.map((l) => l.map(csvField).join(',')).join('\r\n') + '\r\n';
    const filename = `benchmark-${run.created_at.slice(0, 10)}-${run.id.slice(0, 8)}.csv`;
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .send(body);
  }),
);

/** The same queries and settings again, as a new run — before and after a change. */
benchmarkRouter.post(
  '/:id/rerun',
  handle(async (req, res) => {
    const run = await loadRun(String(req.params['id']));
    if (!run) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const id = await createRun(
      { name: run.name, lang: run.lang, modes: run.modes, queries: run.queries },
      req.user?.email ?? null,
    );
    kickBenchmarks();
    res.status(201).json({ id });
  }),
);

benchmarkRouter.post(
  '/:id/cancel',
  handle(async (req, res) => {
    await query(
      `UPDATE benchmark_runs SET status = 'cancelled', finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [String(req.params['id'])],
    );
    res.json({ ok: true });
  }),
);

benchmarkRouter.delete(
  '/:id',
  handle(async (req, res) => {
    await query(`DELETE FROM benchmark_runs WHERE id = $1`, [String(req.params['id'])]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ helpers */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadRun(id: string): Promise<RunRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await query<RunRow>(
    `SELECT id, name, lang, modes, queries, status, total, error, created_by,
            created_at::text, started_at::text, finished_at::text
       FROM benchmark_runs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadCells(runId: string): Promise<CellRow[]> {
  const { rows } = await query<CellRow>(
    `SELECT query_no, mode, hits, total, answer, duration_ms, error
       FROM benchmark_cells WHERE run_id = $1 ORDER BY query_no, mode`,
    [runId],
  );
  return rows;
}

/**
 * An expected answer may name a card or a service. Quick search collapses a
 * service's branches into one card, and which branch represents it depends on
 * distance and ranking — so a card id copied from one branch would count the
 * right service, shown through another branch, as a miss.
 */
function isExpected(hit: Hit, expected: string[]): boolean {
  return expected.includes(hit.card_id) || expected.includes(hit.service_id);
}

/** 1-based position of the first expected result, or null. */
function rankOf(hits: Hit[], expected: string[]): number | null {
  if (expected.length === 0) return null;
  const i = hits.findIndex((h) => isExpected(h, expected));
  return i === -1 ? null : i + 1;
}

function summarise(run: RunRow, byKey: Map<string, CellRow>) {
  return run.modes.map((mode) => {
    let cells = 0;
    let errors = 0;
    let empty = 0;
    let judged = 0;
    let hit1 = 0;
    let hit3 = 0;
    let hit10 = 0;
    let found = 0;
    let reciprocal = 0;
    let ms = 0;
    run.queries.forEach((item, i) => {
      const cell = byKey.get(`${i + 1}:${mode}`);
      if (!cell) return;
      cells++;
      ms += cell.duration_ms ?? 0;
      if (cell.error) errors++;
      else if (cell.hits.length === 0) empty++;
      if (item.expected.length === 0) return;
      judged++;
      const rank = rankOf(cell.hits, item.expected);
      if (rank === null) return;
      found++;
      reciprocal += 1 / rank;
      if (rank <= 1) hit1++;
      if (rank <= 3) hit3++;
      if (rank <= 10) hit10++;
    });
    return {
      mode,
      cells,
      errors,
      empty,
      judged,
      found,
      hit1,
      hit3,
      hit10,
      mrr: judged ? reciprocal / judged : null,
      avg_ms: cells ? Math.round(ms / cells) : null,
    };
  });
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toHit(card: Record<string, unknown>): Hit {
  return {
    card_id: String(card['card_id']),
    service_id: String(card['service_id']),
    service_name: String(card['service_name'] ?? ''),
    organization_name: String(card['organization_name'] ?? ''),
    branch_name: (card['branch_name'] as string | null) ?? null,
    city: (card['city'] as string | null) ?? null,
  };
}

/* ------------------------------------------------------------------- worker */

interface Outcome {
  hits: Hit[];
  total: number | null;
  answer: string | null;
}

async function runCell(q: string, mode: Mode, lang: string): Promise<Outcome> {
  if (mode === 'quick') {
    const result = await searchCards({ q, lang, limit: QUICK_LIMIT });
    return {
      hits: result.cards.map((c) => toHit(c as unknown as Record<string, unknown>)),
      total: result.total,
      answer: null,
    };
  }
  if (!smartAvailable()) throw new Error('neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set');
  const result = await runSmartSearch({
    q,
    lang,
    format: mode === 'free' ? 'prose' : 'brief',
    started: Date.now(),
    record: false,
  });
  if (result.declined) throw new Error('declined: the model refused this query');
  const hits = result.cards.map((c) => toHit(c as Record<string, unknown>));
  return { hits, total: hits.length, answer: result.answer || null };
}

let draining = false;

/**
 * Starts the background loop if it is not already going. Safe to call as often
 * as anyone likes: after creating a run, and once at boot to pick up runs a
 * restart interrupted.
 */
export function kickBenchmarks(): void {
  if (draining) return;
  draining = true;
  void drain()
    .catch((err: Error) => console.error('[error] benchmark worker:', err.stack ?? err.message))
    .finally(() => {
      draining = false;
    });
}

async function drain(): Promise<void> {
  for (;;) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM benchmark_runs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1`,
    );
    const id = rows[0]?.id;
    if (!id) return;
    try {
      await processRun(id);
    } catch (err) {
      await query(
        `UPDATE benchmark_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [id, (err as Error).message],
      );
    }
  }
}

async function stillWanted(id: string): Promise<boolean> {
  const { rows } = await query<{ status: string }>(`SELECT status FROM benchmark_runs WHERE id = $1`, [id]);
  return rows[0]?.status === 'running';
}

async function processRun(id: string): Promise<void> {
  const run = await loadRun(id);
  if (!run) return;
  await query(
    `UPDATE benchmark_runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1`,
    [id],
  );

  const done = new Set((await loadCells(id)).map((c) => `${c.query_no}:${c.mode}`));
  const tasks: { queryNo: number; q: string; mode: Mode }[] = [];
  run.queries.forEach((item, i) => {
    for (const mode of run.modes) {
      if (!done.has(`${i + 1}:${mode}`)) tasks.push({ queryNo: i + 1, q: item.query, mode });
    }
  });

  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < tasks.length) {
      const task = tasks[next++]!;
      // Checked before every cell, so cancelling (or deleting) a run stops it
      // within one search rather than after the whole list.
      if (!(await stillWanted(id))) {
        stopped = true;
        return;
      }
      const started = Date.now();
      let outcome: Outcome = { hits: [], total: null, answer: null };
      let error: string | null = null;
      try {
        outcome = await runCell(task.q, task.mode, run.lang);
      } catch (err) {
        error = (err as Error).message;
      }
      await query(
        `INSERT INTO benchmark_cells (run_id, query_no, mode, hits, total, answer, duration_ms, error)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
          WHERE EXISTS (SELECT 1 FROM benchmark_runs WHERE id = $1)
         ON CONFLICT (run_id, query_no, mode) DO NOTHING`,
        [id, task.queryNo, task.mode, JSON.stringify(outcome.hits), outcome.total, outcome.answer, Date.now() - started, error],
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  await query(
    `UPDATE benchmark_runs SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'running'`,
    [id],
  );
}
