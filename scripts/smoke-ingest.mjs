#!/usr/bin/env node
/**
 * Exercises the write path end to end: create a source, mint a key, push,
 * re-push, dry-run, and withdraw.
 *
 *   ADMIN_TOKEN=... node scripts/smoke-ingest.mjs [baseUrl]
 *
 * Everything it creates is namespaced under a throwaway source and cleaned up,
 * so it is safe to run against a populated instance.
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required');
  process.exit(1);
}

const SOURCE_SLUG = 'smoke-test-source';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const service = (overrides = {}) => ({
  external_id: 'smoke-1',
  name: 'שירות בדיקה אוטומטית',
  description: 'רשומה שנוצרה על ידי בדיקת המערכת ואינה שירות אמיתי.',
  responses: ['human_services:food:food_pantry'],
  situations: ['human_situations:deprivation:low_income'],
  organization: { external_id: 'smoke-org', name: 'ארגון בדיקה' },
  branches: [
    {
      external_id: 'smoke-branch-1',
      name: 'סניף בדיקה',
      address: 'הרצל 1, תל אביב',
      city: 'תל אביב יפו',
      lat: 32.06,
      lon: 34.78,
      phone_numbers: ['03-0000000'],
    },
  ],
  ...overrides,
});

async function main() {
  console.log(`Ingest against ${BASE}\n`);

  console.log('authentication');
  {
    const noKey = await call('/api/v1/ingest/services', { method: 'POST', body: { services: [service()] } });
    check('a push without a key is rejected', noKey.status === 401, `status ${noKey.status}`);

    const badKey = await call('/api/v1/ingest/whoami', { token: 'ssil_not-a-real-key' });
    check('an unknown key is rejected', badKey.status === 401, `status ${badKey.status}`);
  }

  console.log('\nsetting up a source and a key');
  const source = await call('/api/admin/sources', {
    method: 'POST',
    token: ADMIN_TOKEN,
    // Above the auto-publish threshold, so the happy path is exercised.
    body: { slug: SOURCE_SLUG, name: 'Smoke test source', kind: 'webhook', trust_level: 100 },
  });
  check('a source can be created', source.status === 201, JSON.stringify(source.body).slice(0, 120));

  const keyRes = await call('/api/admin/keys', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { name: 'smoke test key', source_slug: SOURCE_SLUG, scopes: ['ingest:write'] },
  });
  check('a key can be minted', keyRes.status === 201 && typeof keyRes.body?.key === 'string');
  const KEY = keyRes.body?.key;
  check('the key is returned only with a warning that it is shown once',
    typeof keyRes.body?.note === 'string');

  const listed = await call('/api/admin/keys', { token: ADMIN_TOKEN });
  check('listing keys never reveals the secret',
    JSON.stringify(listed.body).includes(KEY) === false,
    'a full key appeared in the key listing');

  console.log('\nintrospection');
  {
    const who = await call('/api/v1/ingest/whoami', { token: KEY });
    check('whoami reports the source', who.body?.source === SOURCE_SLUG, JSON.stringify(who.body));
    check('whoami says whether pushes publish immediately', who.body?.publishes_immediately === true);
  }

  console.log('\nvalidation');
  {
    const noTags = await call('/api/v1/ingest/services', {
      method: 'POST',
      token: KEY,
      body: { services: [service({ responses: [] })] },
    });
    check('a service with no response tag is rejected', noTags.status === 400, `status ${noTags.status}`);

    const badTag = await call('/api/v1/ingest/services', {
      method: 'POST',
      token: KEY,
      body: { services: [service({ responses: ['human_services:not_a_real_category'] })] },
    });
    check('an unknown taxonomy id is rejected rather than dropped',
      badTag.body?.results?.[0]?.status === 'rejected',
      JSON.stringify(badTag.body).slice(0, 200));
    check('the rejection names the offending id and how to find valid ones',
      (badTag.body?.results?.[0]?.error ?? '').includes('not_a_real_category'),
      badTag.body?.results?.[0]?.error);
  }

  console.log('\ndry run');
  {
    const before = await call('/api/v1/search?q=' + encodeURIComponent('שירות בדיקה אוטומטית'));
    const dry = await call('/api/v1/ingest/services', {
      method: 'POST',
      token: KEY,
      body: { dry_run: true, services: [service()] },
    });
    check('a dry run reports what would happen', dry.body?.results?.[0]?.status === 'created',
      JSON.stringify(dry.body?.results));
    const after = await call('/api/v1/search?q=' + encodeURIComponent('שירות בדיקה אוטומטית'));
    check('a dry run writes nothing', (after.body?.total ?? 0) === (before.body?.total ?? 0),
      `${before.body?.total} then ${after.body?.total}`);
  }

  console.log('\npushing');
  {
    const first = await call('/api/v1/ingest/services', {
      method: 'POST', token: KEY, body: { services: [service()] },
    });
    check('a push is accepted', first.status === 202, `status ${first.status}`);
    check('the service is created', first.body?.results?.[0]?.status === 'created',
      JSON.stringify(first.body?.results));
    check('the response says the data was published, not queued',
      first.body?.published_immediately === true);

    // Identity is (source, external_id), so the same payload must land on the
    // same record rather than making a second one.
    const again = await call('/api/v1/ingest/services', {
      method: 'POST', token: KEY, body: { services: [service()] },
    });
    check('re-pushing the same record does not duplicate it',
      again.body?.results?.[0]?.status === 'unchanged',
      JSON.stringify(again.body?.results));

    const changed = await call('/api/v1/ingest/services', {
      method: 'POST', token: KEY, body: { services: [service({ name: 'שירות בדיקה אוטומטית מעודכן' })] },
    });
    check('a changed record reports which fields changed',
      (changed.body?.results?.[0]?.changes ?? []).includes('name'),
      JSON.stringify(changed.body?.results));
  }

  console.log('\npartial failure');
  {
    const mixed = await call('/api/v1/ingest/services', {
      method: 'POST',
      token: KEY,
      body: {
        services: [
          service({ external_id: 'smoke-good', name: 'שירות תקין לבדיקה' }),
          service({ external_id: 'smoke-bad', responses: ['human_services:nonsense'] }),
        ],
      },
    });
    const statuses = (mixed.body?.results ?? []).map((r) => r.status);
    check('one bad item does not block the rest',
      statuses.includes('rejected') && statuses.some((s) => s === 'created' || s === 'updated'),
      statuses.join(', '));
  }

  console.log('\nvisibility after rebuild');
  {
    await call('/api/admin/rebuild', { method: 'POST', token: ADMIN_TOKEN });
    const found = await call('/api/v1/search?q=' + encodeURIComponent('שירות בדיקה'));
    check('a pushed service becomes searchable after a rebuild',
      (found.body?.total ?? 0) > 0, `total ${found.body?.total}`);
  }

  console.log('\nwithdrawal');
  {
    const gone = await call('/api/v1/ingest/services/smoke-1', { method: 'DELETE', token: KEY });
    check('a service can be withdrawn', gone.body?.status === 'archived', JSON.stringify(gone.body));

    const unknown = await call('/api/v1/ingest/services/never-existed', { method: 'DELETE', token: KEY });
    check('withdrawing something unknown is a 404', unknown.status === 404, `status ${unknown.status}`);
  }

  console.log('\ncleaning up');
  {
    await call(`/api/admin/keys/${keyRes.body.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
    const revoked = await call('/api/v1/ingest/whoami', { token: KEY });
    check('a revoked key stops working', revoked.status === 401, `status ${revoked.status}`);

    await call('/api/admin/purge-source?slug=' + SOURCE_SLUG, { method: 'POST', token: ADMIN_TOKEN });
    await call('/api/admin/rebuild', { method: 'POST', token: ADMIN_TOKEN });
    const left = await call('/api/v1/search?q=' + encodeURIComponent('שירות בדיקה'));
    check('test data is gone afterwards', (left.body?.total ?? 0) === 0, `total ${left.body?.total}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
