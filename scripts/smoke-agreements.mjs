#!/usr/bin/env node
/**
 * Exercises the agreements path: does this service already exist, and what
 * happens to the document when it does.
 *
 *   ADMIN_TOKEN=... node scripts/smoke-agreements.mjs [baseUrl]
 *
 * It pushes one deliberately odd-sounding service, then asks the matcher about
 * variations of it — the same record, the same name from a different body, a
 * name nothing resembles — and checks that each gets the answer it should.
 * Everything is namespaced under a throwaway source and purged at the end, so
 * it is safe against a populated instance.
 *
 * The names here are nonsense on purpose. Against a corpus of eleven thousand
 * real services, a plausible test name matches something real and the assertion
 * then measures the corpus rather than the matcher.
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required');
  process.exit(1);
}

const SOURCE_SLUG = 'smoke-agreements';
const DOC_ID = 'agreement-77-2026';

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

const SERVICE_NAME = 'מועדון גלגלית לתושבי רחוב פלמוני';
const ORG_NAME = 'עמותת גלגלית פלמונית';
const PHONE = '03-0000041';

const service = (overrides = {}) => ({
  external_id: 'smoke-agreement-service',
  name: SERVICE_NAME,
  description: 'רשומה שנוצרה על ידי בדיקת המערכת ואינה שירות אמיתי.',
  responses: ['human_services:care:daytime_care'],
  organization: { external_id: 'smoke-agreement-org', name: ORG_NAME },
  phone_numbers: [PHONE],
  branches: [
    {
      external_id: 'smoke-agreement-branch',
      address: 'הרצל 1, תל אביב',
      city: 'תל אביב יפו',
      lat: 32.06,
      lon: 34.78,
      phone_numbers: [PHONE],
    },
  ],
  ...overrides,
});

async function main() {
  console.log(`Agreements against ${BASE}\n`);

  const source = await call('/api/admin/sources', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { slug: SOURCE_SLUG, name: 'Smoke agreements source', kind: 'webhook', trust_level: 100 },
  });
  check('a source can be created', source.status === 201, JSON.stringify(source.body).slice(0, 120));

  const keyRes = await call('/api/admin/keys', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { name: 'smoke agreements key', source_slug: SOURCE_SLUG, scopes: ['ingest:write'] },
  });
  const KEY = keyRes.body?.key;
  check('a key can be minted', keyRes.status === 201 && typeof KEY === 'string');

  console.log('\nauthentication');
  {
    const noKey = await call('/api/v1/ingest/match', { method: 'POST', body: { services: [service()] } });
    check('matching without a key is rejected', noKey.status === 401, `status ${noKey.status}`);
  }

  console.log('\nbefore anything exists');
  let firstAnswer;
  {
    const res = await call('/api/v1/ingest/match', { method: 'POST', token: KEY, body: { services: [service()] } });
    firstAnswer = res.body?.results?.[0];
    check('a service the corpus has never seen comes back as new',
      firstAnswer?.decision === 'new',
      `${firstAnswer?.decision} — ${JSON.stringify(firstAnswer?.rationale)}`);
    check('the answer says why', Array.isArray(firstAnswer?.rationale) && firstAnswer.rationale.length > 0);
  }

  console.log('\npushing the service');
  {
    const push = await call('/api/v1/ingest/services', { method: 'POST', token: KEY, body: { services: [service()] } });
    check('the service is created', push.body?.results?.[0]?.status === 'created', JSON.stringify(push.body?.results));
    // The matcher reads cards, which are built on publish rather than on write.
    await call('/api/admin/rebuild', { method: 'POST', token: ADMIN_TOKEN });
  }

  const SERVICE_ID = `${SOURCE_SLUG}:smoke-agreement-service`;
  let cardId;

  console.log('\nthe same service again');
  {
    const res = await call('/api/v1/ingest/match', { method: 'POST', token: KEY, body: { services: [service()] } });
    const answer = res.body?.results?.[0];
    cardId = answer?.best?.card_id;
    check('an identical record is recognised', answer?.decision === 'link',
      `${answer?.decision} — ${JSON.stringify(answer?.rationale)}`);
    check('it points at the service that was pushed', answer?.best?.service_id === SERVICE_ID,
      answer?.best?.service_id);
    check('the score is broken into its parts',
      answer?.best?.components && 'name' in answer.best.components && 'contact' in answer.best.components,
      JSON.stringify(answer?.best?.components));
    check('a shared phone number is noticed', answer?.best?.components?.contact === 1,
      JSON.stringify(answer?.best?.components));
    check('matching writes nothing', res.status === 200);
  }

  console.log('\nthe name alone is not enough');
  {
    // Same words, nothing else: no organization, no phone, no town. A high name
    // score with nothing corroborating it must not link on its own.
    const res = await call('/api/v1/ingest/match', {
      method: 'POST',
      token: KEY,
      body: { services: [{ name: SERVICE_NAME }] },
    });
    const answer = res.body?.results?.[0];
    check('a bare name is sent to a person rather than linked', answer?.decision === 'review',
      `${answer?.decision} — ${JSON.stringify(answer?.rationale)}`);
    check('the reason names what was missing',
      (answer?.rationale ?? []).some((r) => r.includes('corroborates')),
      JSON.stringify(answer?.rationale));
    check('the candidate is still found', answer?.best?.service_id === SERVICE_ID, answer?.best?.service_id);
  }

  console.log('\na different body running something with the same name');
  {
    const res = await call('/api/v1/ingest/match', {
      method: 'POST',
      token: KEY,
      body: {
        services: [
          service({
            organization: { name: 'עמותה אחרת לגמרי לבדיקה' },
            phone_numbers: ['08-0000099'],
            branches: [{ external_id: 'x', city: 'באר שבע' }],
          }),
        ],
      },
    });
    const answer = res.body?.results?.[0];
    check('a different provider in a different town is not silently linked',
      answer?.decision !== 'link',
      `${answer?.decision} — ${JSON.stringify(answer?.rationale)}`);
  }

  console.log('\nsomething else entirely');
  {
    const res = await call('/api/v1/ingest/match', {
      method: 'POST',
      token: KEY,
      body: { services: [service({ name: 'זרנוק תמנוני מפוספס לבדיקה', organization: { name: 'זרנוק תמנוני' }, phone_numbers: [] })] },
    });
    const answer = res.body?.results?.[0];
    check('an unrelated service is new', answer?.decision === 'new',
      `${answer?.decision} — best ${answer?.best?.score}`);
  }

  console.log('\nan unknown category is not a match signal');
  {
    const res = await call('/api/v1/ingest/match', {
      method: 'POST',
      token: KEY,
      body: { services: [service({ responses: ['human_services:not_a_real_category'] })] },
    });
    check('matching tolerates a tag the corpus does not have', res.status === 200,
      JSON.stringify(res.body).slice(0, 200));
  }

  console.log('\nrecording the link');
  {
    const dry = await call('/api/v1/ingest/links', {
      method: 'POST',
      token: KEY,
      body: { dry_run: true, links: [{ service_id: SERVICE_ID, external_id: DOC_ID, title: 'הסכם בדיקה' }] },
    });
    check('a dry run reports what would happen', dry.body?.results?.[0]?.status === 'confirmed',
      JSON.stringify(dry.body?.results));

    const listedAfterDry = await call(`/api/v1/ingest/links?external_id=${DOC_ID}`, { token: KEY });
    check('a dry run writes nothing', (listedAfterDry.body?.links ?? []).length === 0,
      JSON.stringify(listedAfterDry.body?.links));

    const real = await call('/api/v1/ingest/links', {
      method: 'POST',
      token: KEY,
      body: {
        links: [
          {
            service_id: SERVICE_ID,
            external_id: DOC_ID,
            kind: 'agreement',
            title: 'הסכם בדיקה 77/2026',
            confidence: 0.91,
            evidence: { note: 'smoke test' },
          },
        ],
      },
    });
    check('a link from a trusted source is confirmed at once',
      real.body?.results?.[0]?.status === 'confirmed', JSON.stringify(real.body?.results));

    const listed = await call(`/api/v1/ingest/links?external_id=${DOC_ID}`, { token: KEY });
    check('the link is listed back', (listed.body?.links ?? []).length === 1, JSON.stringify(listed.body?.links));
    check('the link keeps its evidence', listed.body?.links?.[0]?.confidence === 0.91,
      JSON.stringify(listed.body?.links?.[0]));

    const again = await call('/api/v1/ingest/links', {
      method: 'POST',
      token: KEY,
      body: { links: [{ service_id: SERVICE_ID, external_id: DOC_ID, title: 'הסכם בדיקה 77/2026' }] },
    });
    check('re-sending the same link does not stack another copy', again.status === 202);
    const listedAgain = await call(`/api/v1/ingest/links?external_id=${DOC_ID}`, { token: KEY });
    check('there is still one link', (listedAgain.body?.links ?? []).length === 1,
      `${(listedAgain.body?.links ?? []).length} links`);

    const missing = await call('/api/v1/ingest/links', {
      method: 'POST',
      token: KEY,
      body: { links: [{ service_id: 'nothing:at-all', external_id: DOC_ID }] },
    });
    check('a link to a service that does not exist says so',
      missing.body?.results?.[0]?.status === 'not_found', JSON.stringify(missing.body?.results));
  }

  console.log('\nthe link shows up as provenance');
  {
    if (cardId) {
      const card = await call(`/api/v1/cards/${cardId}`);
      check('the agreement appears among the service\'s data sources',
        (card.body?.data_sources ?? []).some((s) => String(s).includes(DOC_ID)),
        JSON.stringify(card.body?.data_sources));
    } else {
      check('the agreement appears among the service\'s data sources', false, 'no card id from the match');
    }

    const admin = await call('/api/admin/links?status=all', { token: ADMIN_TOKEN });
    const mine = (admin.body?.links ?? []).filter((l) => l.external_id === DOC_ID);
    check('an administrator can see the link', mine.length === 1, `${mine.length} rows`);
    check('the admin row carries the evidence it was decided on',
      mine[0]?.evidence?.note === 'smoke test', JSON.stringify(mine[0]?.evidence));
  }

  console.log('\na person can overrule it');
  {
    const admin = await call('/api/admin/links?status=all', { token: ADMIN_TOKEN });
    const id = (admin.body?.links ?? []).find((l) => l.external_id === DOC_ID)?.id;
    const rejected = await call(`/api/admin/links/${id}?decision=reject&note=smoke`, {
      method: 'POST',
      token: ADMIN_TOKEN,
    });
    check('a link can be rejected', rejected.body?.decision === 'rejected', JSON.stringify(rejected.body));

    // And a later push from the source must not quietly undo that decision.
    await call('/api/v1/ingest/links', {
      method: 'POST',
      token: KEY,
      body: { links: [{ service_id: SERVICE_ID, external_id: DOC_ID, title: 'הסכם בדיקה 77/2026' }] },
    });
    const after = await call(`/api/v1/ingest/links?external_id=${DOC_ID}`, { token: KEY });
    check('re-pushing does not overturn a decision a person made',
      after.body?.links?.[0]?.status === 'rejected', JSON.stringify(after.body?.links?.[0]));
  }

  console.log('\ncleaning up');
  {
    await call(`/api/admin/keys/${keyRes.body.id}`, { method: 'DELETE', token: ADMIN_TOKEN });
    await call('/api/admin/purge-source?slug=' + SOURCE_SLUG, { method: 'POST', token: ADMIN_TOKEN });
    await call('/api/admin/rebuild', { method: 'POST', token: ADMIN_TOKEN });
    const sources = await call('/api/admin/sources', { token: ADMIN_TOKEN });
    const mine = (sources.body?.sources ?? []).find((s) => s.slug === SOURCE_SLUG);
    check('test data is gone afterwards', (mine?.services ?? 0) === 0, `${mine?.services} services left`);
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
