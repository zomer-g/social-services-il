#!/usr/bin/env node
/**
 * End-to-end checks against a running instance.
 *
 * Written in Node rather than shell because the queries are Hebrew, and passing
 * UTF-8 through a shell on Windows silently turns it into question marks — which
 * looks exactly like a broken search engine.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * ADMIN_TOKEN in the environment additionally enables the admin checks.
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: ADMIN_TOKEN && path.startsWith('/api/admin')
      ? { authorization: `Bearer ${ADMIN_TOKEN}` }
      : {},
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const names = (r) => (r.body?.cards ?? []).map((c) => c.service_name);
const has = (r, needle) => names(r).some((n) => n.includes(needle));

async function main() {
  console.log(`Running against ${BASE}\n`);

  console.log('health and shape');
  {
    const h = await get('/api/health');
    check('health responds 200', h.status === 200, `got ${h.status}`);
    check('database reachable', h.body?.checks?.database === 'ok', h.body?.checks?.database);
    check('taxonomy loaded', (h.body?.counts?.taxonomy_nodes ?? 0) > 400, `${h.body?.counts?.taxonomy_nodes}`);

    const stats = await get('/api/v1/stats');
    check('stats responds', stats.status === 200);
    check('corpus is not empty', (stats.body?.cards ?? 0) > 0, `${stats.body?.cards} cards`);
  }

  console.log('\nHebrew normalisation reaches the server intact');
  {
    // The single most valuable assertion here: it catches an encoding problem
    // anywhere between this script and Postgres, which otherwise presents as
    // "search matches everything" and is easy to misread as a ranking bug.
    const r = await get('/api/v1/search', { q: 'מקלט' });
    const all = await get('/api/v1/search', {});
    check('a Hebrew query narrows the corpus rather than matching all of it',
      (r.body?.total ?? 0) > 0 && r.body.total < (all.body?.total ?? 0) / 4,
      `${r.body?.total} of ${all.body?.total}`);
  }

  console.log('\nfinding a service by its own words');
  {
    const r = await get('/api/v1/search', { q: 'בית תמחוי' });
    check('a phrase from real service names finds something', (r.body?.total ?? 0) > 0, `total ${r.body?.total}`);
    check('and what it finds is about food',
      (r.body?.cards ?? []).some((c) => c.response_ids.some((id) => id.startsWith('human_services:food'))),
      names(r).slice(0, 3).join(', '));

    const r2 = await get('/api/v1/search', { q: 'אלימות במשפחה' });
    check('"אלימות במשפחה" finds relevant services', (r2.body?.total ?? 0) > 0, `total ${r2.body?.total}`);
  }

  console.log('\nfinding a service by a word that is not in it');
  {
    // "אוכל" is a synonym on the food category, not a word in that category's
    // own name. It only works if tag text and synonyms are indexed into cards,
    // and those synonyms are the hand-built ones from the export.
    const r = await get('/api/v1/search', { q: 'אוכל' });
    check('a synonym reaches its category', (r.body?.total ?? 0) > 0, `total ${r.body?.total}`);
    check('and the results really are in that category',
      (r.body?.cards ?? []).some((c) => c.response_ids.some((id) => id.startsWith('human_services:food'))),
      names(r).slice(0, 3).join(', '));
  }

  console.log('\nmisspellings');
  {
    // The fallback pass exists for exactly this, and it is the difference
    // between finding a shelter and finding nothing.
    for (const [typo, meant] of [['תמחווי', 'תמחוי'], ['מקלת', 'מקלט'], ['ניצולי שאוה', 'ניצולי שואה']]) {
      const r = await get('/api/v1/search', { q: typo });
      check(`"${typo}" still finds "${meant}"`, (r.body?.total ?? 0) > 0, `total ${r.body?.total}`);
    }
  }

  console.log('\nspeed');
  {
    // Someone in distress on a phone will not wait. This caught a real
    // regression: a predicate shape that defeated the index made every
    // free-text search take about 1.4 seconds on the full corpus.
    const slow = [];
    for (const q of ['סל מזון', 'דיור מוגן', 'אלימות במשפחה', 'ניצולי שואה']) {
      await get('/api/v1/search', { q, limit: 1 });
      const started = Date.now();
      await get('/api/v1/search', { q, limit: 1 });
      const ms = Date.now() - started;
      if (ms > 800) slow.push(`${q}: ${ms}ms`);
    }
    check('free-text search answers well under a second', slow.length === 0, slow.join(', '));
  }

  console.log('\nHebrew morphology');
  {
    // Prefixed and definite forms of the same word must reach the same records.
    const plain = await get('/api/v1/search', { q: 'מזון' });
    const prefixed = await get('/api/v1/search', { q: 'למזון' });
    check('"מזון" finds something', (plain.body?.total ?? 0) > 0, `total ${plain.body?.total}`);
    // Not identical: "מזון" also contributes its de-prefixed form as a prefix
    // match, which reaches a handful of records "למזון" does not. What matters
    // is that the two land on substantially the same set rather than missing
    // each other entirely.
    const ratio =
      Math.min(prefixed.body.total, plain.body.total) / Math.max(prefixed.body.total, plain.body.total);
    check('"למזון" finds substantially what "מזון" finds', ratio > 0.9,
      `${prefixed.body?.total} vs ${plain.body?.total}`);

    // Final-form folding: writing the medial form must still match.
    const finalForm = await get('/api/v1/search', { q: 'מזון' });
    const foldedForm = await get('/api/v1/search', { q: 'מזונ' });
    check('final and medial forms agree', finalForm.body?.total === foldedForm.body?.total,
      `${finalForm.body?.total} vs ${foldedForm.body?.total}`);
  }

  console.log('\na query that should find nothing, finds nothing');
  {
    const r = await get('/api/v1/search', { q: 'זזזזזזז קוואגה' });
    check('nonsense returns no results', r.body?.total === 0, `total ${r.body?.total}`);
  }

  console.log('\nfiltering');
  {
    const all = await get('/api/v1/search', {});
    const national = await get('/api/v1/search', { national_service: 'only' });
    const local = await get('/api/v1/search', { national_service: 'exclude' });
    // An inequality, not an equality: collapsing merges a nationwide card and a
    // local one into a single row, but each half of the split keeps its own.
    check('splitting by nationwide covers the whole corpus',
      (national.body?.total ?? 0) + (local.body?.total ?? 0) >= (all.body?.total ?? -1),
      `${national.body?.total} + ${local.body?.total} vs ${all.body?.total}`);

    const food = await get('/api/v1/search', { response: 'human_services:food' });
    check('a parent category matches services tagged with its children',
      (food.body?.total ?? 0) > 0, `total ${food.body?.total}`);

    const city = await get('/api/v1/search', { city: 'ירושלים' });
    check('filtering by city works', (city.body?.total ?? 0) > 0, `total ${city.body?.total}`);
  }

  console.log('\nlocation');
  {
    // Tel Aviv. The soup kitchen is there; the Haifa branch is 80km away.
    const r = await get('/api/v1/search', { lat: 32.0565, lon: 34.7797, limit: 20 });
    const first = r.body?.cards?.[0];
    check('nearby results carry a distance', first?.distance_m !== undefined, JSON.stringify(first?.distance_m));
    // Ranking blends relevance, substance and proximity, so results are not in
    // strict distance order. What must hold is that a location search returns
    // things that are actually near.
    const localCards = (r.body?.cards ?? []).filter((c) => !c.national_service && c.distance_m != null);
    const median = localCards.map((c) => c.distance_m).sort((a, b) => a - b)[Math.floor(localCards.length / 2)];
    check('a location search returns genuinely nearby services',
      median !== undefined && median < 15000, `median distance ${median}m`);

    const radius = await get('/api/v1/search', { lat: 32.0565, lon: 34.7797, radius_km: 5 });
    const outside = (radius.body?.cards ?? []).filter(
      (c) => !c.national_service && c.distance_m != null && c.distance_m > 5000,
    );
    check('a radius excludes anything beyond it', outside.length === 0, `${outside.length} outside`);
    // Checked against the whole result set rather than the first page: on a real
    // corpus the first twenty rows can legitimately all be local.
    const nationwideInRadius = await get('/api/v1/search', {
      lat: 32.0565, lon: 34.7797, radius_km: 5, national_service: 'only', limit: 1,
    });
    check('a radius still includes nationwide services',
      (nationwideInRadius.body?.total ?? 0) > 0,
      'nationwide services were filtered out by the radius');
  }

  console.log('\ncollapsing');
  {
    const collapsed = await get('/api/v1/search', { limit: 1 });
    const expanded = await get('/api/v1/search', { collapse: 'false', limit: 1 });
    check('collapsing merges duplicates across the corpus',
      (collapsed.body?.total ?? 0) < (expanded.body?.total ?? 0) / 2,
      `${collapsed.body?.total} collapsed vs ${expanded.body?.total} raw`);

    // One service in this corpus is delivered at four thousand places; the
    // collapsed row has to say so, or it reads as a single site.
    const many = await get('/api/v1/search', { q: 'צהרון', limit: 20 });
    const withPlaces = (many.body?.cards ?? []).find((c) => c.also_available_at > 0);
    check('a collapsed row says how many other places offer it', withPlaces !== undefined,
      (many.body?.cards ?? []).map((c) => `${c.service_name}:${c.also_available_at}`).slice(0, 3).join(', '));
  }

  console.log('\nfacets describe the result set');
  {
    const r = await get('/api/v1/search', { response: 'human_services:food' });
    const top = r.body?.facets?.responses?.[0];
    check('facets come back with names', typeof top?.name === 'string', JSON.stringify(top));
    check('no facet counts more than the result set',
      (r.body?.facets?.responses ?? []).every((f) => f.count <= r.body.total),
      'a facet count exceeded the total');
  }

  console.log('\ncard detail and autocomplete');
  {
    const list = await get('/api/v1/search', { limit: 1 });
    const id = list.body?.cards?.[0]?.card_id;
    check('search returns a card id', typeof id === 'string', String(id));
    if (id) {
      const card = await get(`/api/v1/cards/${id}`);
      check('the card can be fetched', card.status === 200, `status ${card.status}`);
      check('the card names its provider', typeof card.body?.organization_name === 'string');
      check('the card carries its taxonomy', Array.isArray(card.body?.responses));
    }
    const missing = await get('/api/v1/cards/00000000');
    check('an unknown card is a 404', missing.status === 404, `status ${missing.status}`);

    const ac = await get('/api/v1/autocomplete', { q: 'מזו' });
    check('autocomplete suggests categories for a partial word',
      (ac.body?.taxonomy ?? []).length > 0, JSON.stringify(ac.body).slice(0, 120));
    check('autocomplete suggestions are not dead ends',
      (ac.body?.taxonomy ?? []).every((t) => t.card_count > 0), 'a suggestion had no services behind it');
  }

  console.log('\ntaxonomy and export');
  {
    const tax = await get('/api/v1/taxonomy', { axis: 'response' });
    check('taxonomy returns response nodes', (tax.body?.nodes ?? []).length > 0);
    check('taxonomy hides empty categories by default',
      (tax.body?.nodes ?? []).every((n) => n.card_count > 0), 'an empty category was returned');

    const res = await fetch(`${BASE}/api/v1/export/cards.ndjson`);
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    check('bulk export returns ndjson', lines.length > 0, `${lines.length} lines`);
    check('every export line is valid JSON', lines.every((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    }));
  }

  console.log('\nbad input');
  {
    const r = await get('/api/v1/search', { lat: 32 });
    check('lat without lon is a 400', r.status === 400, `status ${r.status}`);
    const r2 = await get('/api/v1/search', { limit: 'banana' });
    check('a non-numeric limit is a 400', r2.status === 400, `status ${r2.status}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
