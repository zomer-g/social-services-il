#!/usr/bin/env node
/**
 * Reads a directory of contracting agreements and turns the ones that describe
 * a service into records this instance can hold.
 *
 *   node scripts/agreements.mjs <directory-or-file> [options]
 *
 *   --url <base>        target instance (default http://localhost:3000)
 *   --key <api-key>     ingest key; or set INGEST_KEY. Needed for --match/--push
 *   --out <dir>         where per-document JSON goes (default ./agreements-out)
 *   --model <id>        any model in the catalog (default claude-opus-5); --models lists them
 *   --effort <level>    low | medium | high (default high), moved to the nearest level a model has
 *   --concurrency <n>   documents read at once (default 3)
 *   --limit <n>         stop after n documents
 *   --resume            skip documents that already have output
 *   --match             ask the corpus whether each service already exists
 *   --push              act on the answer: new services pushed, matches linked
 *   --commit            with --push, actually write. Without it, dry run
 *   --today <date>      the date "expired" is judged against (default: today)
 *
 * Four stages, each of which can be run alone and inspected:
 *
 *   read     the document goes to the model with prompts/agreement-to-service.md
 *            and comes back as the JSON that prompt's schema describes
 *   match    every extracted service is put to POST /api/v1/ingest/match, which
 *            answers link / review / new against the whole corpus
 *   push     `new` is pushed as a service, `link` is recorded as a link to the
 *            service that already exists, `review` waits for a person
 *   report   agreements-out/report.md, which is the thing to read
 *
 * Nothing writes without --commit. A directory of agreements is a directory of
 * claims about the world, and the first run is for finding out how good they
 * are, not for publishing them.
 */

import {
  apiKeysFromEnv,
  buildReaderPrompt,
  DEFAULT_MODEL,
  MODELS,
  modelSpec,
  PROVIDER_KEYS,
  readAgreement,
} from '@ssil/ingest';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
/** Options that take no value, so the token after them is the positional. */
const VALUELESS = new Set(['match', 'push', 'commit', 'resume', 'models']);

const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const positional = [];
for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (!token.startsWith('--')) {
    positional.push(token);
    continue;
  }
  if (!VALUELESS.has(token.slice(2))) i++;
}
const target = positional[0];

if (flag('models')) {
  for (const m of MODELS) {
    const keyed = PROVIDER_KEYS[m.provider].some((name) => process.env[name]);
    console.log(
      `${m.id.padEnd(24)} ${m.label.padEnd(24)} $${m.prices.input} in / $${m.prices.output} out` +
        `${keyed ? '' : `   (needs ${PROVIDER_KEYS[m.provider].join(' or ')})`}`,
    );
  }
  process.exit(0);
}

if (!target) {
  console.error('Usage: node scripts/agreements.mjs <directory-or-file> [--model id] [--match] [--push] [--commit]');
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = join(HERE, '..', 'prompts', 'agreement-to-service.md');
const SCHEMA_FILE = join(HERE, '..', 'prompts', 'agreement-extraction.schema.json');

const BASE = opt('url', process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const KEY = opt('key', process.env.INGEST_KEY ?? '');
const OUT = resolve(opt('out', './agreements-out'));
const MODEL = opt('model', DEFAULT_MODEL);
const EFFORT = opt('effort', 'high');
const SPEC = modelSpec(MODEL);
if (!SPEC) {
  console.error(`[error] no model called ${MODEL}. Run with --models to list them.`);
  process.exit(1);
}
if (!['low', 'medium', 'high'].includes(EFFORT)) {
  console.error(`[error] --effort is low, medium or high, not ${EFFORT}`);
  process.exit(1);
}
const API_KEYS = apiKeysFromEnv();
if (!API_KEYS[SPEC.provider]) {
  console.error(`[error] ${MODEL} needs ${PROVIDER_KEYS[SPEC.provider].join(' or ')} in the environment`);
  process.exit(1);
}
const CONCURRENCY = Math.max(1, Number(opt('concurrency', '3')) || 3);
const LIMIT = Number(opt('limit', '0')) || 0;
const TODAY = opt('today', new Date().toISOString().slice(0, 10));
const RESUME = flag('resume');
const DO_MATCH = flag('match') || flag('push');
const DO_PUSH = flag('push');
const COMMIT = flag('commit');

/** What the model can be handed directly, and what has to be converted first. */
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.html', '.htm', '.xml']);
const PDF_EXTENSION = '.pdf';
/**
 * Google and OpenAI take PDFs up to 50 MB. A larger one goes to each provider's
 * file upload rather than inside the request, but it is still better split.
 */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

main().catch((err) => {
  console.error(`[error] ${err.stack ?? err.message}`);
  process.exit(1);
});

async function main() {
  const files = await collect(target);
  if (files.length === 0) {
    console.error(`[error] nothing readable under ${target}. Expected ${[...TEXT_EXTENSIONS, PDF_EXTENSION].join(', ')}`);
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const prompt = await buildPrompt();
  const schema = JSON.parse(await readFile(SCHEMA_FILE, 'utf8'));

  const queue = LIMIT ? files.slice(0, LIMIT) : files;
  console.log(`[info] ${queue.length} document(s), model ${MODEL}, effort ${EFFORT}`);
  console.log(`[info] taxonomy and prompt: ${prompt.length.toLocaleString()} characters, cached between documents`);

  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (index < queue.length) {
      const file = queue[index++];
      const outFile = join(OUT, `${basename(file, extname(file))}.json`);
      if (RESUME && (await exists(outFile))) {
        results.push(JSON.parse(await readFile(outFile, 'utf8')));
        console.log(`[skip] ${basename(file)} (already read)`);
        continue;
      }
      try {
        const result = await readDocument(file, prompt, schema);
        await writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
        results.push(result);
        const n = result.extraction?.services?.length ?? 0;
        console.log(`[read] ${basename(file)} → ${result.extraction?.verdict?.decision ?? 'failed'}, ${n} service(s)`);
      } catch (err) {
        const failure = { file, error: err.message, ...(err.usage ? { usage: err.usage, cost: err.cost, attempts: err.attempts } : {}) };
        results.push(failure);
        await writeFile(outFile, JSON.stringify(failure, null, 2), 'utf8');
        console.error(`[fail] ${basename(file)}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  if (DO_MATCH) await matchAll(results);
  if (DO_PUSH) await pushAll(results);

  await writeFile(join(OUT, 'report.json'), JSON.stringify(results, null, 2), 'utf8');
  const report = renderReport(results);
  await writeFile(join(OUT, 'report.md'), report, 'utf8');
  console.log(`\n${report}`);
  console.log(`[info] written to ${OUT}`);
}

/* ---------------------------------------------------------------- reading */

/**
 * The prompt with its placeholders filled.
 *
 * The taxonomy is fetched rather than pasted in, because a category list that
 * has drifted from the corpus produces tags the write API then drops — a
 * service that exists and cannot be found. `include_empty=true`: a category
 * nothing currently sits under is still a legitimate answer for a new service,
 * and it is exactly where a service nobody has yet collected would belong.
 */
async function buildPrompt() {
  const [template, schemaText, responses, situations] = await Promise.all([
    readFile(PROMPT_FILE, 'utf8'),
    readFile(SCHEMA_FILE, 'utf8'),
    fetchTaxonomy('response'),
    fetchTaxonomy('situation'),
  ]);
  // The same assembly the screen uses, so a document read here and the same
  // document read there were given the same instructions.
  return buildReaderPrompt({ template, schemaText, nodes: [...responses, ...situations], today: TODAY });
}

async function fetchTaxonomy(axis) {
  const res = await fetch(`${BASE}/api/v1/taxonomy?axis=${axis}&lang=he&include_empty=true`);
  if (!res.ok) throw new Error(`taxonomy fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.nodes ?? []).map((n) => ({ id: n.id, axis: n.axis ?? axis, depth: n.depth, name: n.name }));
}

async function readDocument(file, prompt, schema) {
  const document = await documentFor(file);

  // The shared reader: any provider, the shape checked against the schema on
  // arrival, one corrective turn for an answer that does not validate, and the
  // spend counted on every turn whether or not the document succeeds.
  const result = await readAgreement({
    modelId: MODEL,
    effort: EFFORT,
    system: prompt,
    schema,
    document,
    apiKeys: API_KEYS,
  });

  const usage = {
    input: result.usage.input,
    output: result.usage.output,
    cache_read: result.usage.cacheRead,
    cache_write: result.usage.cacheWrite,
    reasoning: result.usage.reasoning,
  };

  if (!result.ok) {
    // The spend travels with the failure, so the report's total is what was
    // actually paid rather than what the successful documents cost.
    throw Object.assign(new Error(`${result.error.kind}: ${result.error.message}`), {
      usage,
      cost: result.cost,
      attempts: result.attempts,
    });
  }

  const extraction = result.extraction;
  // The document's own id is what makes a second run update rather than
  // duplicate, and a model asked for a stable one still sometimes leaves it
  // empty. The file name is a worse id but a deterministic one.
  const fallbackId = slug(basename(file, extname(file)));
  extraction.document ??= {};
  if (!extraction.document.external_id) extraction.document.external_id = fallbackId;
  for (const [i, service] of (extraction.services ?? []).entries()) {
    if (!service.external_id) service.external_id = `${extraction.document.external_id}-${i + 1}`;
  }

  return {
    file,
    read_at: new Date().toISOString(),
    model: result.servedModel ?? MODEL,
    effort: result.effort,
    attempts: result.attempts,
    elapsed_ms: result.elapsedMs,
    usage,
    cost: result.cost,
    extraction,
    warnings: validate(extraction),
  };
}

async function documentFor(file) {
  const ext = extname(file).toLowerCase();
  if (ext === PDF_EXTENSION) {
    const bytes = await readFile(file);
    if (bytes.length > MAX_PDF_BYTES) {
      throw new Error(`${(bytes.length / 1e6).toFixed(1)} MB is over the ${MAX_PDF_BYTES / 1e6} MB limit; split it first`);
    }
    return { filename: basename(file), pdf: bytes };
  }
  return { filename: basename(file), text: await readFile(file, 'utf8') };
}


/**
 * Checks the extraction against the rules the write API will enforce anyway,
 * before anything is sent — so a mistake is a line in the report rather than a
 * rejected item in a batch of two hundred.
 */
function validate(extraction) {
  const warnings = [];
  for (const service of extraction.services ?? []) {
    const where = service.external_id ?? service.name ?? '(unnamed)';
    if (!service.responses?.length) warnings.push(`${where}: no response tag — it would be unreachable`);
    if (!service.organization?.name) warnings.push(`${where}: no provider named`);
    if (!service.national_service && !(service.branches ?? []).some((b) => b.city || b.address)) {
      warnings.push(`${where}: neither nationwide nor anywhere — no card can be built from it`);
    }
    if (service.organization?.id && !/^\d{8,9}$/.test(String(service.organization.id))) {
      warnings.push(`${where}: organization.id "${service.organization.id}" is not a registration number`);
    }
    if (!service.source_quotes?.length) warnings.push(`${where}: nothing quoted from the document`);
  }
  if (extraction.verdict?.decision === 'relevant' && !(extraction.services ?? []).length) {
    warnings.push('verdict says relevant but no service was extracted');
  }
  if (extraction.verdict?.expired) warnings.push('the agreement has expired');
  return warnings;
}

/* --------------------------------------------------------------- matching */

async function matchAll(results) {
  requireKey('--match');
  for (const result of results) {
    const services = servicesOf(result);
    if (!services.length) continue;
    const body = { services: services.map(forApi) };
    const res = await api('/api/v1/ingest/match', body);
    result.match = res.results;
    for (const [i, m] of res.results.entries()) {
      console.log(`[match] ${services[i].name} → ${m.decision}${m.best ? ` (${m.best.service_name}, ${m.best.score})` : ''}`);
    }
  }
}

/* ---------------------------------------------------------------- pushing */

async function pushAll(results) {
  requireKey('--push');
  const dryRun = !COMMIT;
  const toCreate = [];
  const toLink = [];

  for (const result of results) {
    const services = servicesOf(result);
    services.forEach((service, i) => {
      const match = result.match?.[i];
      if (!match || match.decision === 'new') {
        toCreate.push({ result, service });
      } else if (match.decision === 'link') {
        toLink.push({ result, service, match });
      }
      // `review` is deliberately neither. A person decides, and until they do
      // the corpus is unchanged — which is the whole point of having a third
      // answer instead of forcing every candidate into yes or no.
    });
  }

  console.log(
    `\n[push] ${toCreate.length} new, ${toLink.length} link(s), ` +
      `${countReview(results)} waiting for a person — ${dryRun ? 'DRY RUN' : 'writing'}`,
  );

  if (toCreate.length) {
    const res = await api('/api/v1/ingest/services', {
      dry_run: dryRun,
      services: toCreate.map(({ service }) => forApi(service)),
    });
    for (const item of res.results) {
      const owner = toCreate.find(({ service }) => service.external_id === item.external_id);
      if (owner) (owner.result.pushed ??= []).push(item);
      if (item.error) console.error(`[push] ${item.external_id}: ${item.error}`);
    }
    console.log(`[push] services: ${JSON.stringify(res.summary)}`);
  }

  if (toLink.length) {
    const res = await api('/api/v1/ingest/links', {
      dry_run: dryRun,
      links: toLink.map(({ result, service, match }) => ({
        service_id: match.best.service_id,
        external_id: result.extraction.document.external_id,
        kind: result.extraction.document.kind ?? 'agreement',
        title: result.extraction.document.title ?? undefined,
        confidence: match.best.score,
        method: 'matcher',
        evidence: {
          decision: match.decision,
          rationale: match.rationale,
          components: match.best.components,
          reasons: match.best.reasons,
          runner_up: match.candidates?.[1]
            ? { service_id: match.candidates[1].service_id, name: match.candidates[1].service_name, score: match.candidates[1].score }
            : null,
          candidate: { name: service.name, organization: service.organization?.name ?? null },
          document: result.extraction.document,
          source_quotes: service.source_quotes ?? [],
        },
      })),
    });
    for (const item of res.results) {
      const owner = toLink.find(({ match }) => match.best.service_id === item.service_id);
      if (owner) (owner.result.linked ??= []).push(item);
    }
    console.log(`[push] links: ${JSON.stringify(res.summary)}`);
  }
}

/* ----------------------------------------------------------------- report */

function renderReport(results) {
  const lines = [];
  const counts = { relevant: 0, partial: 0, irrelevant: 0, failed: 0 };
  const decisions = { link: 0, review: 0, new: 0 };
  let services = 0;
  let cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let spent = 0;
  let marginal = 0;
  let read = 0;

  for (const r of results) {
    if (!r.extraction) counts.failed++;
    else counts[r.extraction.verdict?.decision ?? 'failed']++;
    services += servicesOf(r).length;
    for (const m of r.match ?? []) decisions[m.decision]++;
    for (const key of Object.keys(cost)) cost[key] += r.usage?.[key] ?? 0;
    spent += r.cost?.total ?? 0;
    if (r.extraction && r.cost) {
      marginal += r.cost.marginal;
      read++;
    }
  }

  lines.push('# Agreements', '');
  lines.push(`${results.length} document(s) read with ${MODEL} (effort ${EFFORT}) on ${new Date().toISOString().slice(0, 10)} against ${BASE}.`, '');
  lines.push('| | |', '| --- | --- |');
  lines.push(`| Describe a service | ${counts.relevant} |`);
  lines.push(`| Describe one but not usably | ${counts.partial} |`);
  lines.push(`| Nothing for the public | ${counts.irrelevant} |`);
  lines.push(`| Could not be read | ${counts.failed} |`);
  lines.push(`| Services extracted | ${services} |`);
  if (DO_MATCH) {
    lines.push(`| Already in the corpus | ${decisions.link} |`);
    lines.push(`| Need a person to decide | ${decisions.review} |`);
    lines.push(`| New to the corpus | ${decisions.new} |`);
  }
  lines.push(
    `| Tokens | ${cost.input.toLocaleString()} in, ${cost.output.toLocaleString()} out, ${cost.cache_read.toLocaleString()} cached |`,
  );
  lines.push(`| Spent | $${spent.toFixed(3)} |`);
  if (read) {
    // Marginal, not total: the first document pays to cache the prompt and is
    // not what the thousandth one costs.
    lines.push(`| Per document, once the prompt is cached | $${(marginal / read).toFixed(4)} — $${((marginal / read) * 1000).toFixed(0)} per thousand |`);
  }
  lines.push('');

  const needsPerson = results.filter(
    (r) => (r.match ?? []).some((m) => m.decision === 'review') || (r.warnings ?? []).length,
  );
  if (needsPerson.length) {
    lines.push('## Waiting for a person', '');
    for (const r of needsPerson) {
      lines.push(`### ${basename(r.file)}`);
      if (r.extraction?.document?.title) lines.push(`*${r.extraction.document.title}*`);
      for (const w of r.warnings ?? []) lines.push(`- ⚠ ${w}`);
      for (const [i, m] of (r.match ?? []).entries()) {
        if (m.decision !== 'review') continue;
        const service = servicesOf(r)[i];
        lines.push(`- **${service?.name ?? m.name}** — ${m.rationale.join(' ')}`);
        for (const c of (m.candidates ?? []).slice(0, 3)) {
          lines.push(`  - ${c.score} · ${c.service_name} · ${c.organization_name} · ${c.city ?? 'ארצי'} · \`${c.service_id}\``);
        }
      }
      for (const q of r.extraction?.questions ?? []) lines.push(`- ? ${q}`);
      lines.push('');
    }
  }

  const rejected = results.filter((r) => r.extraction?.verdict?.decision === 'irrelevant');
  if (rejected.length) {
    lines.push('## Not services', '');
    for (const r of rejected) {
      lines.push(`- **${basename(r.file)}** — ${r.extraction.verdict.subject}: ${r.extraction.verdict.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ shared */

function servicesOf(result) {
  return result.extraction?.services ?? [];
}

function countReview(results) {
  return results.reduce((n, r) => n + (r.match ?? []).filter((m) => m.decision === 'review').length, 0);
}

/**
 * The extraction shape and the API shape are the same shape, minus the fields
 * that exist for a reviewer rather than for the database, and minus the nulls
 * that a strict schema forces on absent values. Sending a null where the API
 * expects an absent key is how "we do not know" becomes "we know it is empty".
 */
function forApi(service) {
  const { confidence, source_quotes, ...rest } = service;
  return stripNulls(rest);
}

function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls).filter((v) => v !== null && v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function requireKey(why) {
  if (KEY) return;
  console.error(`[error] ${why} needs an ingest key: --key ssil_... or INGEST_KEY=...`);
  process.exit(1);
}

async function collect(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return readable(path) ? [resolve(path)] : [];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (readable(full)) files.push(resolve(full));
  }
  return files.sort();
}

function readable(file) {
  const ext = extname(file).toLowerCase();
  return ext === PDF_EXTENSION || TEXT_EXTENSIONS.has(ext);
}

async function exists(file) {
  return !!(await stat(file).catch(() => null));
}

function slug(value) {
  return value.replace(/\s+/g, '-').replace(/[^\w֐-׿.-]/gu, '').slice(0, 120) || 'document';
}
