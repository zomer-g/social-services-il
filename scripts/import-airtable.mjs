#!/usr/bin/env node
/**
 * Imports the six-table export — Organizations, Branches, Services, Locations,
 * Responses, Situations — into a running instance.
 *
 *   node scripts/import-airtable.mjs <directory> [options]
 *
 *   --url <base>        target instance (default http://localhost:3000)
 *   --key <api-key>     ingest key; or set INGEST_KEY
 *   --admin <token>     admin token, needed for --taxonomy
 *   --taxonomy          import the Responses/Situations tables first
 *   --services          import services (default when neither flag is given)
 *   --dry-run           report what would change, write nothing
 *   --limit <n>         only the first n services, for a trial run
 *   --out <file>        write the converted payload to a file instead of pushing
 *   --report <file>     write per-item results to a file
 *
 * It pushes through the public write API rather than reaching into the
 * database, so the import is subject to the same validation, attribution and
 * audit trail as any other source, and can be aimed at a staging instance first.
 *
 * Files are matched by their columns, not their names, because exports get
 * renamed. Run with --out first and read the result before pushing anything.
 */

import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && !isOptionValue(a));

function isOptionValue(value) {
  const i = args.indexOf(value);
  return i > 0 && args[i - 1].startsWith('--');
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (!dir) {
  console.error('Usage: node scripts/import-airtable.mjs <directory> [--taxonomy] [--url ...] [--key ...] [--out file]');
  process.exit(1);
}

const BASE = opt('url', process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const KEY = opt('key', process.env.INGEST_KEY ?? '');
const ADMIN = opt('admin', process.env.ADMIN_TOKEN ?? '');
const DRY = flag('dry-run');
const LIMIT = Number(opt('limit', '0')) || 0;
const OUT = opt('out', '');
const REPORT = opt('report', '');
/** Resume point, in services. Upserts are idempotent, so re-running is safe. */
const START = Number(opt('start', '0')) || 0;
const DO_TAXONOMY = flag('taxonomy');
const DO_SERVICES = flag('services') || !DO_TAXONOMY;

/**
 * A batch is bounded by branch count rather than service count. Services are not
 * comparable in size here: most have one branch, one has four thousand, and a
 * fixed count of services per request produces either tiny requests or ones that
 * exceed the body limit.
 */
const MAX_SERVICES_PER_BATCH = 100;
const MAX_BRANCHES_PER_BATCH = 1500;
const MAX_ATTEMPTS = 4;

/**
 * Posts one batch, retrying on a dropped connection.
 *
 * A long import is a long-lived keep-alive conversation, and the far side will
 * eventually close one: over a full run the server closed a socket after about
 * five megabytes. Since every write is an idempotent upsert, retrying the same
 * batch is safe and far cheaper than losing the run.
 */
async function postBatch(url, headers, body) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        // A fresh connection each time, rather than reusing one the server may
        // already have decided to close.
        keepalive: false,
      });
      return { res, body: await res.json().catch(() => null) };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Streaming CSV reader.
 *
 * Streamed rather than read whole because the services table alone is 42 MB, and
 * character-by-character work over a string that size is both slow and a large
 * transient allocation. Handles quoted fields, embedded commas and newlines, and
 * doubled quotes; written out rather than pulled in so the import works from a
 * checkout with no install step.
 */
async function readCsv(path, onRow) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let header = null;
  let row = [];
  let field = '';
  let quoted = false;
  let first = true;
  let count = 0;

  const finishField = () => {
    row.push(field);
    field = '';
  };
  const finishRow = () => {
    finishField();
    if (first) {
      // A byte-order mark survives Excel exports and would otherwise become
      // part of the first column name, so no column ever matches.
      if (row[0]?.charCodeAt(0) === 0xfeff) row[0] = row[0].slice(1);
      header = row.map((h) => h.trim());
      first = false;
    } else if (row.some((v) => v !== '')) {
      const obj = {};
      for (let i = 0; i < header.length; i += 1) obj[header[i]] = (row[i] ?? '').trim();
      onRow(obj);
      count += 1;
    }
    row = [];
  };

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (quoted) {
        if (ch === '"') {
          if (chunk[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ',') finishField();
      else if (ch === '\n') finishRow();
      else if (ch !== '\r') field += ch;
    }
  }
  if (field !== '' || row.length) finishRow();
  return count;
}

/* -------------------------------------------------------------- recognition */

const SIGNATURES = [
  { name: 'locations', any: ['resolved_lat', 'resolved_lon', 'fixed_lat', 'resolved_address'] },
  { name: 'services', any: ['response_ids', 'responses_manual_ids', 'final_responses', 'name_manual'] },
  { name: 'responses', any: ['breadcrumbs'], require: ['name_en'], not: ['category'] },
  { name: 'situations', any: ['category'], require: ['breadcrumbs'] },
  { name: 'branches', any: ['operating_unit', 'address_details', 'location_accuracy'] },
  { name: 'organizations', any: ['short_name', 'purpose'] },
];

function identify(header) {
  const cols = new Set(header.map((c) => c.toLowerCase()));
  for (const sig of SIGNATURES) {
    if ((sig.require ?? []).some((c) => !cols.has(c))) continue;
    if ((sig.not ?? []).some((c) => cols.has(c))) continue;
    if (sig.any.some((c) => cols.has(c))) return sig.name;
  }
  return null;
}

async function headerOf(path) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
    // Good enough for identification: column names contain no commas here.
    return clean.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
  }
  return [];
}

/* ---------------------------------------------------------------- utilities */

const val = (row, ...names) => {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
};

/**
 * A linked-record column holds a comma or newline separated list of ids. Only
 * used for columns whose values are ids; a location reference is a free-text
 * address and is never split, because 3,923 of them contain a comma.
 */
const asList = (value) =>
  (value ?? '')
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

const num = (value) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * payment_required is yes / no / sometimes in this corpus. "Sometimes" is read
 * as "there may be a charge": telling someone with no money that a service is
 * free when it might not be is the more damaging of the two errors, and
 * payment_details carries the nuance.
 *
 * The `boost` column is deliberately not imported. It holds values up to 300,
 * and this system treats boost as a power of ten, so importing it verbatim
 * would produce infinities. Editorial ranking is better re-established
 * deliberately than inherited with unknown semantics.
 */
const truthy = (value) =>
  value !== undefined && ['true', '1', 'yes', 'checked', 'sometimes', 'כן'].includes(String(value).toLowerCase());

/**
 * The geocoders in this corpus report accuracy in their own vocabulary. Anything
 * at street level or better can be navigated to; the rest is shown with a
 * warning, because a pin on a city centroid misleads more than a missing pin.
 */
const ACCURACY = {
  ROOFTOP: 'rooftop',
  ADDR_V1: 'building',
  RANGE_INTERPOLATED: 'street',
  GEOMETRIC_CENTER: 'approximate',
  APPROXIMATE: 'approximate',
  POI_MID_POINT: 'approximate',
  SETL_MID_POINT: 'locality',
  SETL_V1: 'locality',
  NATIONAL_SERVICE: 'unknown',
};

/* ------------------------------------------------------------------ loading */

async function loadTables() {
  const files = await readdir(dir);
  const tables = {};
  for (const file of files) {
    if (!['.csv', '.tsv'].includes(extname(file).toLowerCase())) continue;
    const path = join(dir, file);
    const kind = identify(await headerOf(path));
    if (!kind) {
      console.warn(`  ? ${file} — could not tell which table this is, skipping`);
      continue;
    }
    tables[kind] ??= [];
    const n = await readCsv(path, (row) => tables[kind].push(row));
    console.log(`  ${kind.padEnd(14)} ${String(n).padStart(7)} rows  (${file})`);
  }
  return tables;
}

/* ----------------------------------------------------------------- taxonomy */

async function importTaxonomy(tables) {
  const nodes = [];
  for (const [table, axis] of [['responses', 'response'], ['situations', 'situation']]) {
    for (const row of tables[table] ?? []) {
      const id = val(row, 'id');
      if (!id || !id.includes(':')) continue;
      if (val(row, 'status') === 'INACTIVE') continue;
      nodes.push({
        id,
        axis,
        name: val(row, 'name'),
        name_en: val(row, 'name_en'),
        description: val(row, 'description'),
        pk: val(row, 'pk'),
        // The synonyms are the most valuable thing in these two tables: years of
        // editorial work, and absent from the published taxonomy file.
        synonyms: asList(val(row, 'synonyms')),
      });
    }
  }

  const synonymCount = nodes.reduce((n, x) => n + x.synonyms.length, 0);
  console.log(`\n  ${nodes.length} taxonomy nodes, ${synonymCount} synonyms`);

  if (OUT) {
    await writeFile(OUT, JSON.stringify({ nodes }, null, 2), 'utf8');
    console.log(`  written to ${OUT}`);
    return;
  }
  if (!ADMIN) {
    console.error('  --admin <token> is required to import the taxonomy');
    process.exit(1);
  }

  const res = await fetch(`${BASE}/api/admin/taxonomy/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ nodes }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error('  failed:', res.status, JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }
  console.log(`  imported ${body.nodes} nodes, ${body.names} names, ${body.synonyms} synonyms`);
  for (const s of body.skipped ?? []) console.warn('  skipped:', s);
}

/* ----------------------------------------------------------------- services */

function convertServices(tables) {
  const orgs = new Map((tables.organizations ?? []).map((o) => [val(o, 'id'), o]));
  const branches = new Map((tables.branches ?? []).map((b) => [val(b, 'id'), b]));
  const locations = new Map((tables.locations ?? []).map((l) => [val(l, 'id'), l]));

  const services = [];
  const skipped = { inactive: 0, no_name: 0, no_org: 0, no_response: 0 };

  for (const row of tables.services ?? []) {
    // Only ACTIVE records are published upstream, and importing the rest would
    // resurrect services that were deliberately withdrawn.
    if (val(row, 'status') !== 'ACTIVE') {
      skipped.inactive += 1;
      continue;
    }

    const externalId = val(row, 'id');
    const name = val(row, 'name_manual', 'name');
    if (!externalId || !name) {
      skipped.no_name += 1;
      continue;
    }

    // final_* are the curated result of manual tags overriding scraped ones;
    // preferring them keeps years of editorial work that the raw columns lose.
    const responses = asList(val(row, 'final_responses', 'responses_manual_ids', 'response_ids'));
    const situations = asList(val(row, 'final_situations', 'situations_manual_ids', 'situation_ids'));
    if (responses.length === 0) {
      skipped.no_response += 1;
      continue;
    }

    // The organisation is reached through the branches, not from the service.
    // Only 207 of ~12,000 active services fill their own organizations column;
    // for the rest the provider is a property of each place the service is
    // delivered at, and 108 services are delivered by more than one body.
    const branchRows = asList(val(row, 'branches'))
      .map((id) => [id, branches.get(id)])
      .filter(([, b]) => b && val(b, 'status') !== 'INACTIVE');

    const orgIds = [
      ...asList(val(row, 'organizations')),
      ...branchRows.map(([, b]) => val(b, 'organization')).filter(Boolean),
    ];
    const primaryOrgId = orgIds.find((id) => orgs.has(id));
    const orgRow = primaryOrgId ? orgs.get(primaryOrgId) : undefined;
    const orgName = orgRow ? val(orgRow, 'name') : undefined;
    if (!orgRow || !orgName) {
      skipped.no_org += 1;
      continue;
    }
    const orgId = primaryOrgId;

    const orgOf = (id) => {
      const o = orgs.get(id);
      const name = o ? val(o, 'name') : undefined;
      if (!o || !name) return undefined;
      const rawId = val(o, 'id');
      return {
        id: /^\d{9}$/.test(rawId ?? '') ? rawId : undefined,
        external_id: rawId,
        name: name.slice(0, 400),
        short_name: val(o, 'short_name')?.slice(0, 200),
        kind: val(o, 'kind')?.slice(0, 100),
        purpose: val(o, 'purpose')?.slice(0, 4000),
        description: val(o, 'description')?.slice(0, 8000),
        phone_numbers: asList(val(o, 'phone_numbers')).slice(0, 10),
      };
    };

    const serviceBranches = [];
    for (const [branchId, b] of branchRows) {
      // Never split this: a location id is a free-text address and thousands of
      // them contain a comma.
      const locRow = locations.get(val(b, 'location') ?? '');
      const rawAccuracy = val(b, 'location_accuracy') ?? val(locRow ?? {}, 'accuracy');
      const national = rawAccuracy === 'NATIONAL_SERVICE';

      // A hand-corrected coordinate beats the geocoder's, as it does upstream.
      const lat = num(val(locRow ?? {}, 'fixed_lat')) ?? num(val(locRow ?? {}, 'resolved_lat'));
      const lon = num(val(locRow ?? {}, 'fixed_lon')) ?? num(val(locRow ?? {}, 'resolved_lon'));

      const branchOrgId = val(b, 'organization');
      const branchOrg = branchOrgId && branchOrgId !== orgId ? orgOf(branchOrgId) : undefined;

      serviceBranches.push({
        external_id: branchId,
        name: val(b, 'name')?.slice(0, 300),
        operating_unit: val(b, 'operating_unit')?.slice(0, 300),
        description: val(b, 'description')?.slice(0, 4000),
        address: val(b, 'address')?.slice(0, 500),
        address_details: val(b, 'address_details')?.slice(0, 500),
        city: val(b, 'branch_city') ?? val(locRow ?? {}, 'resolved_city'),
        ...(national ? { national_service: true } : {}),
        ...(!national && lat !== undefined && lon !== undefined ? { lat, lon } : {}),
        location_accuracy: national ? 'unknown' : (ACCURACY[rawAccuracy] ?? 'unknown'),
        phone_numbers: asList(val(b, 'phone_numbers')).slice(0, 10),
        source_updated_at: sourceDate(val(b, 'last_modified')),
        ...(branchOrg ? { organization: branchOrg } : {}),
      });
    }

    services.push({
      external_id: externalId,
      name: name.slice(0, 400),
      description: val(row, 'description')?.slice(0, 8000),
      details: val(row, 'details')?.slice(0, 8000),
      payment_required: truthy(val(row, 'payment_required')),
      payment_details: val(row, 'payment_details')?.slice(0, 2000),
      phone_numbers: asList(val(row, 'phone_numbers')).slice(0, 10),
      implements: val(row, 'implements')?.slice(0, 500),
      source_updated_at: sourceDate(val(row, 'Last Modified'), val(row, 'last_modified')),
      responses,
      situations,
      organization: orgOf(orgId),
      branches: serviceBranches,
    });

    if (LIMIT && services.length >= LIMIT) break;
  }

  return { services, skipped };
}

/**
 * The export carries two modification dates, in two different formats.
 *
 * Services have `Last Modified` as `YYYY-MM-DD h:mma`, which is unambiguous, and
 * a `last_modified` as `D/M/YYYY h:mma`, which is not: 5/7/2026 is either the
 * fifth of July or the seventh of May. It is day-first — the two columns agree
 * on the date for every row sampled, and 18/2/2026 settles it — but the ISO
 * column is preferred wherever it exists rather than relying on that.
 *
 * Branches have only the ambiguous one.
 *
 * The time carries no zone. It is read as Israel time, which is where every
 * record in this corpus was written; being an hour or two out matters far less
 * than the alternative, which was to serve the rebuild timestamp and call it
 * freshness.
 */
function sourceDate(...values) {
  for (const raw of values) {
    const value = (raw ?? '').trim();
    if (!value) continue;

    const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*([ap]m)?$/i.exec(value);
    if (iso) {
      const [, y, m, d, h, min, ampm] = iso;
      return israelTime(+y, +m, +d, hour24(+h, ampm), +min);
    }

    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})\s*([ap]m)?$/i.exec(value);
    if (dmy) {
      const [, d, m, y, h, min, ampm] = dmy;
      if (+m > 12) continue;
      return israelTime(+y, +m, +d, hour24(+h, ampm), +min);
    }
  }
  return undefined;
}

function hour24(hour, ampm) {
  if (!ampm) return hour;
  if (ampm.toLowerCase() === 'pm') return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

/**
 * Israel is UTC+2, or +3 under daylight saving — which runs from the Friday
 * before the last Sunday of March to the last Sunday of October. Worth the few
 * lines: getting it wrong would put a record an hour into the future, and a
 * date in the future is the one thing a freshness field must never show.
 */
function israelTime(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h - 2, mi);
  return new Date(guess - (inIsraelDst(guess) ? 3600_000 : 0)).toISOString();
}

function inIsraelDst(ms) {
  const year = new Date(ms).getUTCFullYear();
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const start = Date.UTC(year, 2, lastSunday(2) - 2, 0);
  const end = Date.UTC(year, 9, lastSunday(9), 1);
  return ms >= start && ms < end;
}

function* batches(services) {
  let batch = [];
  let branchCount = 0;
  for (const service of services) {
    const n = service.branches.length;
    if (batch.length && (batch.length >= MAX_SERVICES_PER_BATCH || branchCount + n > MAX_BRANCHES_PER_BATCH)) {
      yield batch;
      batch = [];
      branchCount = 0;
    }
    batch.push(service);
    branchCount += n;
  }
  if (batch.length) yield batch;
}

async function importServices(tables) {
  const { services: allServices, skipped } = convertServices(tables);
  const services = START ? allServices.slice(START) : allServices;
  const branchTotal = allServices.reduce((n, s) => n + s.branches.length, 0);
  console.log(
    `\n  ${services.length} services converted (${branchTotal} service-branch pairs)\n` +
      `  skipped: ${skipped.inactive} inactive, ${skipped.no_response} with no response tag, ` +
      `${skipped.no_org} with no organisation, ${skipped.no_name} with no name`,
  );

  if (OUT) {
    await writeFile(OUT, JSON.stringify({ services }, null, 2), 'utf8');
    console.log(`  written to ${OUT}. Read it before pushing.`);
    return;
  }
  if (!KEY) {
    console.error('  no ingest key. Pass --key, set INGEST_KEY, or use --out to inspect first.');
    process.exit(1);
  }

  console.log(`\n  ${DRY ? 'dry run against' : 'pushing to'} ${BASE}`);
  const totals = {};
  const problems = [];
  let n = 0;
  const started = Date.now();

  for (const batch of batches(services)) {
    n += 1;
    const { res, body } = await postBatch(
      `${BASE}/api/v1/ingest/services`,
      { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, connection: 'close' },
      JSON.stringify({ dry_run: DRY, services: batch }),
    );

    if (!res.ok && !body?.results) {
      console.error(`  batch ${n}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      problems.push({ batch: n, status: res.status, body });
      continue;
    }

    for (const [status, count] of Object.entries(body.summary ?? {})) {
      totals[status] = (totals[status] ?? 0) + count;
    }
    for (const r of body.results ?? []) {
      if (r.status === 'rejected' || r.warnings) problems.push(r);
    }

    const done = Object.values(totals).reduce((a, b) => a + b, 0);
    process.stdout.write(
      `\r  batch ${n}: ${done}/${services.length} services, ${Math.round((Date.now() - started) / 1000)}s elapsed   `,
    );
  }

  console.log(`\n\n  total: ${JSON.stringify(totals)}`);

  const rejected = problems.filter((p) => p.status === 'rejected');
  const warned = problems.filter((p) => p.warnings);
  if (rejected.length) {
    console.log(`\n  ${rejected.length} rejected. First few:`);
    for (const r of rejected.slice(0, 5)) console.log(`    ${r.external_id}: ${r.error}`);
  }
  if (warned.length) {
    console.log(`\n  ${warned.length} written with warnings. First few:`);
    for (const r of warned.slice(0, 5)) console.log(`    ${r.external_id}: ${r.warnings.join('; ')}`);
  }

  if (REPORT) {
    await writeFile(REPORT, JSON.stringify({ totals, problems }, null, 2), 'utf8');
    console.log(`\n  full report written to ${REPORT}`);
  }
  if (!DRY) console.log('\n  Run POST /api/admin/rebuild to make the new records searchable.');
}

/* --------------------------------------------------------------------- main */

async function main() {
  console.log(`reading ${dir}`);
  const tables = await loadTables();

  if (DO_TAXONOMY) {
    console.log('\n=== taxonomy ===');
    await importTaxonomy(tables);
  }
  if (DO_SERVICES) {
    if (!tables.services?.length) {
      console.error('\nNo services table found.');
      process.exit(1);
    }
    console.log('\n=== services ===');
    await importServices(tables);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
