#!/usr/bin/env node
/**
 * Imports the six-table export (Organizations, Branches, Services, Locations,
 * Responses, Situations) into a running instance.
 *
 *   node scripts/import-airtable.mjs <directory> [options]
 *
 *   --url <base>        target instance (default http://localhost:3000)
 *   --key <api-key>     ingest key; or set INGEST_KEY
 *   --dry-run           report what would change, write nothing
 *   --limit <n>         only the first n services, for a trial run
 *   --batch <n>         services per request (default 100)
 *   --out <file>        write the converted payload to a file instead of pushing
 *
 * It pushes through the public write API rather than reaching into the database,
 * so the import is exercised by the same validation, attribution and audit trail
 * as any other source — and can be pointed at a staging instance first.
 *
 * Files are matched by their columns, not their names, because exports get
 * renamed. Run with --out first and read the result before pushing anything.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (!dir) {
  console.error('Usage: node scripts/import-airtable.mjs <directory> [--url ...] [--key ...] [--dry-run] [--out file]');
  process.exit(1);
}

const BASE = (opt('url', process.env.BASE_URL ?? 'http://localhost:3000')).replace(/\/$/, '');
const KEY = opt('key', process.env.INGEST_KEY ?? '');
const DRY = flag('dry-run');
const LIMIT = Number(opt('limit', '0')) || 0;
const BATCH = Number(opt('batch', '100'));
const OUT = opt('out', '');

/* ------------------------------------------------------------------ parsing */

/**
 * CSV reader that handles quoted fields, embedded commas and newlines, and
 * doubled quotes. Written out rather than pulled in, because the import must
 * work from a checkout with no install step, and this is the whole of what a
 * spreadsheet export needs.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  // A byte-order mark survives Excel exports and would otherwise become part of
  // the first column name, so no column ever matches.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
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
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

async function readTable(path) {
  const text = await readFile(path, 'utf8');
  if (extname(path).toLowerCase() === '.json') {
    const parsed = JSON.parse(text);
    // Accept both a bare array and Airtable's {records:[{fields:{...}}]} shape.
    if (Array.isArray(parsed)) return parsed.map((r) => r.fields ?? r);
    if (Array.isArray(parsed.records)) return parsed.records.map((r) => r.fields ?? r);
    if (Array.isArray(parsed.data)) return parsed.data;
    return [];
  }
  return parseCsv(text);
}

/* -------------------------------------------------------------- recognition */

/**
 * Which table is which, decided by the columns present. Each entry lists
 * columns that together identify the table; the first match wins, so the more
 * specific signatures come first.
 */
const SIGNATURES = [
  { name: 'locations', required: ['id'], any: ['resolved_lat', 'resolved_lon', 'fixed_lat', 'resolved_address', 'accuracy'] },
  { name: 'services', required: ['name'], any: ['response_ids', 'situation_ids', 'responses', 'situations', 'payment_required', 'branches'] },
  { name: 'branches', required: [], any: ['organization', 'location', 'address_details', 'operating_unit'] },
  { name: 'organizations', required: ['name'], any: ['short_name', 'kind', 'purpose'] },
  { name: 'responses', required: ['id'], any: ['breadcrumbs', 'synonyms'] },
  { name: 'situations', required: ['id'], any: ['breadcrumbs', 'synonyms'] },
];

function identify(rows) {
  if (!rows.length) return null;
  const cols = new Set(Object.keys(rows[0]).map((c) => c.toLowerCase()));
  for (const sig of SIGNATURES) {
    const hasRequired = sig.required.every((c) => cols.has(c));
    const hasAny = sig.any.some((c) => cols.has(c));
    if (hasRequired && hasAny) return sig.name;
  }
  return null;
}

/* ---------------------------------------------------------------- utilities */

const get = (row, ...names) => {
  for (const n of names) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === n.toLowerCase()) {
        const v = row[key];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
  }
  return undefined;
};

/**
 * Airtable writes a linked-record column as a comma or newline separated list
 * of keys, and a JSON export writes it as an array.
 */
const asList = (value) => {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  return String(value)
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
};

const num = (value) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const truthy = (value) =>
  value !== undefined && ['true', '1', 'yes', 'כן'].includes(String(value).toLowerCase());

/* ------------------------------------------------------------------- import */

async function main() {
  const files = await readdir(dir);
  const tables = {};

  for (const file of files) {
    if (!['.csv', '.json', '.tsv'].includes(extname(file).toLowerCase())) continue;
    const rows = await readTable(join(dir, file));
    const kind = identify(rows);
    if (!kind) {
      console.warn(`  ? ${file} — could not tell which table this is, skipping (${Object.keys(rows[0] ?? {}).slice(0, 6).join(', ')})`);
      continue;
    }
    // Two files can identify as the same table (a split export); keep both.
    tables[kind] = [...(tables[kind] ?? []), ...rows];
    console.log(`  ${kind.padEnd(14)} ${String(rows.length).padStart(6)} rows  (${file})`);
  }

  if (!tables.services?.length) {
    console.error('\nNo services table found. Nothing to import.');
    process.exit(1);
  }

  // Airtable links by an opaque key column; everything is joined on it.
  const index = (rows, ...keyNames) => {
    const map = new Map();
    for (const row of rows ?? []) {
      const key = get(row, ...keyNames);
      if (key) map.set(key, row);
      const id = get(row, 'id');
      if (id) map.set(id, row);
    }
    return map;
  };

  const orgs = index(tables.organizations, 'key');
  const branches = index(tables.branches, 'key');
  const locations = index(tables.locations, 'key');

  console.log('\nconverting');
  const services = [];
  let skipped = 0;

  for (const row of tables.services) {
    const externalId = get(row, 'id', 'key', 'service_id');
    const name = get(row, 'name_manual', 'name');
    if (!externalId || !name) {
      skipped += 1;
      continue;
    }

    // The manual columns are the curated ones and win, which is the whole point
    // of the export having them.
    const responses = asList(get(row, 'responses_manual_ids') ?? get(row, 'response_ids') ?? get(row, 'responses'));
    const situations = asList(get(row, 'situations_manual_ids') ?? get(row, 'situation_ids') ?? get(row, 'situations'));

    if (!responses.length) {
      skipped += 1;
      continue;
    }

    const orgKeys = asList(get(row, 'organizations', 'organization'));
    const orgRow = orgKeys.map((k) => orgs.get(k)).find(Boolean);
    const orgName = orgRow ? get(orgRow, 'name') : undefined;
    if (!orgName) {
      skipped += 1;
      continue;
    }

    const branchKeys = asList(get(row, 'branches'));
    const serviceBranches = [];
    for (const key of branchKeys) {
      const b = branches.get(key);
      if (!b) continue;
      const locRow = locations.get(asList(get(b, 'location'))[0] ?? '');
      // A hand-corrected coordinate beats the geocoder's, exactly as the source
      // pipeline treats it.
      const lat = num(get(locRow ?? {}, 'fixed_lat')) ?? num(get(locRow ?? {}, 'resolved_lat'));
      const lon = num(get(locRow ?? {}, 'fixed_lon')) ?? num(get(locRow ?? {}, 'resolved_lon'));
      serviceBranches.push({
        external_id: get(b, 'id', 'key') ?? key,
        name: get(b, 'name'),
        operating_unit: get(b, 'operating_unit'),
        description: get(b, 'description'),
        address: get(b, 'address'),
        address_details: get(b, 'address_details'),
        city: get(locRow ?? {}, 'resolved_city'),
        ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
        phone_numbers: asList(get(b, 'phone_numbers')).slice(0, 10),
      });
    }

    services.push({
      external_id: externalId,
      name,
      description: get(row, 'description'),
      details: get(row, 'details'),
      payment_required: truthy(get(row, 'payment_required')),
      payment_details: get(row, 'payment_details'),
      phone_numbers: asList(get(row, 'phone_numbers')).slice(0, 10),
      email_address: get(row, 'email_address'),
      implements: get(row, 'implements'),
      responses,
      situations,
      organization: {
        id: get(orgRow, 'id')?.match(/^\d{9}$/) ? get(orgRow, 'id') : undefined,
        external_id: get(orgRow, 'id', 'key'),
        name: orgName,
        short_name: get(orgRow, 'short_name'),
        kind: get(orgRow, 'kind'),
        purpose: get(orgRow, 'purpose'),
        description: get(orgRow, 'description'),
        phone_numbers: asList(get(orgRow, 'phone_numbers')).slice(0, 10),
      },
      branches: serviceBranches,
    });

    if (LIMIT && services.length >= LIMIT) break;
  }

  console.log(`  ${services.length} services converted, ${skipped} skipped (no name, no organisation, or no response tag)`);

  if (OUT) {
    await writeFile(OUT, JSON.stringify({ services }, null, 2), 'utf8');
    console.log(`\nWritten to ${OUT}. Read it before pushing.`);
    return;
  }

  if (!KEY) {
    console.error('\nNo ingest key. Pass --key or set INGEST_KEY, or use --out to inspect the conversion first.');
    process.exit(1);
  }

  console.log(`\n${DRY ? 'dry run against' : 'pushing to'} ${BASE}`);
  const totals = {};
  for (let i = 0; i < services.length; i += BATCH) {
    const batch = services.slice(i, i + BATCH);
    const res = await fetch(`${BASE}/api/v1/ingest/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ dry_run: DRY, services: batch }),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok && !body?.results) {
      console.error(`  batch ${i / BATCH + 1}: HTTP ${res.status}`, JSON.stringify(body).slice(0, 400));
      continue;
    }

    for (const [status, n] of Object.entries(body.summary ?? {})) {
      totals[status] = (totals[status] ?? 0) + n;
    }
    // Rejections are the point of running this: report them as they happen so a
    // systematic mapping error is visible on the first batch, not the last.
    for (const r of body.results ?? []) {
      if (r.status === 'rejected') console.error(`  rejected ${r.external_id}: ${r.error}`);
    }
    console.log(`  batch ${i / BATCH + 1}/${Math.ceil(services.length / BATCH)}: ${JSON.stringify(body.summary)}`);
  }

  console.log(`\ntotal: ${JSON.stringify(totals)}`);
  if (!DRY) console.log('Run POST /api/admin/rebuild to make the new records searchable.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
