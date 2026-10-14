import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import { geminiFunctions, geminiToolLoop } from './gemini.js';
import type { SharedTool } from './tools.js';

/**
 * The Gemini loop without a key or a network: what it sends, and how it reads
 * function calls, refusals and errors. fetch is replaced for each test.
 */

const tool: SharedTool = {
  name: 'search_services',
  title: 'Search services',
  description: 'Search.',
  schema: { q: z.string().describe('What to look for'), limit: z.number().int().optional() },
  handler: async () => ({ services: [] }),
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function scripted(replies: unknown[]): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const reply = replies.shift();
    const status = (reply as { status?: number }).status ?? 200;
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return { bodies };
}

describe('geminiFunctions', () => {
  it('declares the tool parameters as JSON Schema without the $schema marker', () => {
    const [fn] = geminiFunctions([tool]);
    const params = fn!['parametersJsonSchema'] as Record<string, unknown>;
    assert.equal(fn!['name'], 'search_services');
    assert.equal(params['$schema'], undefined);
    assert.equal(params['type'], 'object');
    assert.deepEqual(params['required'], ['q']);
  });
});

describe('geminiToolLoop', () => {
  it('runs a function call, returns its result, and keeps the thought signature', async () => {
    const { bodies } = scripted([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'c1', name: 'search_services', args: { q: 'סל מזון' } }, thoughtSignature: 'sig' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'מצאתי.' }] } }] },
    ]);
    const seen: unknown[] = [];
    const result = await geminiToolLoop({
      apiKey: 'k',
      system: 'sys',
      userText: 'סל מזון',
      tools: [tool],
      maxTurns: 6,
      maxOutputTokens: 100,
      callTool: async (name, args) => {
        seen.push([name, args]);
        return { content: { services: [{ card_id: 'a' }] }, isError: false };
      },
    });

    assert.deepEqual(result, { declined: false, answer: 'מצאתי.' });
    assert.deepEqual(seen, [['search_services', { q: 'סל מזון' }]]);
    assert.equal(bodies.length, 2);
    const second = bodies[1]!['contents'] as { role: string; parts: Record<string, unknown>[] }[];
    assert.equal(second[1]!.role, 'model');
    assert.equal(second[1]!.parts[0]!['thoughtSignature'], 'sig');
    assert.deepEqual(second[2], {
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'search_services', response: { result: { services: [{ card_id: 'a' }] } } } }],
    });
    assert.deepEqual((bodies[0]!['systemInstruction'] as { parts: unknown[] }).parts, [{ text: 'sys' }]);
  });

  it('reports a safety stop as declined', async () => {
    scripted([{ candidates: [{ finishReason: 'SAFETY' }] }]);
    const result = await geminiToolLoop({
      apiKey: 'k', system: 's', userText: 'x', tools: [tool], maxTurns: 6, maxOutputTokens: 100,
      callTool: async () => ({ content: null, isError: false }),
    });
    assert.equal(result.declined, true);
  });

  it('throws the provider message on an HTTP error', async () => {
    scripted([{ status: 400, error: { message: 'API key not valid' } }]);
    await assert.rejects(
      geminiToolLoop({
        apiKey: 'k', system: 's', userText: 'x', tools: [tool], maxTurns: 6, maxOutputTokens: 100,
        callTool: async () => ({ content: null, isError: false }),
      }),
      /Gemini 400: API key not valid/,
    );
  });
});
