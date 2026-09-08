#!/usr/bin/env node
/**
 * Exercises the MCP endpoint with a real client, rather than hand-rolled
 * JSON-RPC, so the transport handshake is covered too.
 *
 *   node scripts/smoke-mcp.mjs [baseUrl]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

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

const textOf = (result) => result.content.map((c) => c.text ?? '').join('\n');
const jsonOf = (result) => JSON.parse(textOf(result));

async function main() {
  console.log(`MCP against ${BASE}/mcp\n`);

  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));

  console.log('discovery');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('tools are advertised', tools.length >= 8, names.join(', '));
  for (const expected of [
    'search_services',
    'find_services_near',
    'get_service',
    'find_taxonomy',
    'list_taxonomy',
    'get_organization',
    'emergency_lines',
    'corpus_stats',
  ]) {
    check(`tool ${expected} exists`, names.includes(expected));
  }
  check('every tool describes itself', tools.every((t) => (t.description ?? '').length > 20));

  const { resources } = await client.listResources();
  check('taxonomy resources are exposed', resources.length >= 2, resources.map((r) => r.uri).join(', '));

  const { prompts } = await client.listPrompts();
  check('a guided prompt is offered', prompts.length >= 1, prompts.map((p) => p.name).join(', '));

  console.log('\ncalling tools');
  const stats = jsonOf(await client.callTool({ name: 'corpus_stats', arguments: {} }));
  check('corpus_stats reports a non-empty corpus', stats.services_at_places > 0, JSON.stringify(stats));

  const emergency = jsonOf(await client.callTool({ name: 'emergency_lines', arguments: {} }));
  check('emergency_lines returns numbers', (emergency.lines ?? []).length >= 5);
  check('emergency_lines includes the police number',
    (emergency.lines ?? []).some((l) => l.phone === '100'));

  const taxonomy = jsonOf(
    await client.callTool({ name: 'find_taxonomy', arguments: { query: 'מזון', lang: 'he' } }),
  );
  check('find_taxonomy maps a Hebrew need to ids', (taxonomy.matches ?? []).length > 0, JSON.stringify(taxonomy).slice(0, 160));
  check('find_taxonomy reports how many services back each id',
    (taxonomy.matches ?? []).every((m) => typeof m.card_count === 'number'));

  const searched = jsonOf(
    await client.callTool({ name: 'search_services', arguments: { query: 'ארוחה חמה', lang: 'he' } }),
  );
  check('search_services finds a service by Hebrew text', searched.total > 0, JSON.stringify(searched).slice(0, 160));
  check('every result carries a last_updated date',
    (searched.services ?? []).every((s) => typeof s.last_updated === 'string'),
    'a result had no last_updated, so an assistant could not say how fresh it is');
  check('results suggest how to narrow down', Array.isArray(searched.narrow_by?.responses));

  const near = jsonOf(
    await client.callTool({
      name: 'find_services_near',
      arguments: { lat: 32.0565, lon: 34.7797, radius_km: 10, lang: 'he' },
    }),
  );
  check('find_services_near returns nearby services', (near.nearby ?? []).length > 0);
  check('nearby results carry a distance',
    (near.nearby ?? []).every((s) => typeof s.distance_km === 'number'));
  check('nationwide services are listed separately, not mixed in',
    Array.isArray(near.also_available_nationwide));

  const firstId = searched.services?.[0]?.card_id;
  if (firstId) {
    const service = jsonOf(await client.callTool({ name: 'get_service', arguments: { card_id: firstId } }));
    check('get_service returns the full record', typeof service.service_name === 'string');
    check('get_service says what the service provides', Array.isArray(service.provides));
  }

  const missing = await client.callTool({ name: 'get_service', arguments: { card_id: '00000000' } });
  check('an unknown id gets a plain answer rather than an error',
    textOf(missing).includes('No service'), textOf(missing).slice(0, 80));

  const browse = jsonOf(await client.callTool({ name: 'list_taxonomy', arguments: { axis: 'response', lang: 'he' } }));
  check('list_taxonomy browses top-level categories', (browse.nodes ?? []).length > 0);
  check('empty categories are hidden by default',
    (browse.nodes ?? []).every((n) => n.card_count > 0));

  console.log('\nresources and prompts');
  const resource = await client.readResource({ uri: 'taxonomy://responses' });
  const parsed = JSON.parse(resource.contents[0].text);
  check('the response taxonomy resource is readable JSON', Array.isArray(parsed) && parsed.length > 100,
    `${parsed.length} nodes`);

  const prompt = await client.getPrompt({ name: 'find-help', arguments: { situation: 'אין לי כסף לאוכל', place: 'תל אביב' } });
  check('the prompt renders with its arguments',
    prompt.messages[0].content.text.includes('אין לי כסף לאוכל'));

  await client.close();

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
