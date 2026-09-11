import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { geminiRequestBody, parseGeminiChunks } from './google.js';
import { parseBlock } from './http.js';
import { apiKeysFromEnv, readAgreement } from './read.js';
import { costOf, effortFor, MODELS, modelSpec } from './models.js';
import { openaiRequestBody, parseOpenAIResponse } from './openai.js';
import { buildReaderPrompt } from './prompt.js';
import { ReaderError } from './types.js';

/**
 * The parts of reading that can be checked without a key or a network: what is
 * sent to each provider, how each provider's reply is understood, and what it
 * is charged at. The payload fixtures follow the providers' published response
 * shapes; a provider changing them is caught by the smoke checks, not here.
 */

const spec = (id: string) => {
  const found = modelSpec(id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
};

describe('catalog', () => {
  it('has three providers and no duplicate ids', () => {
    assert.equal(new Set(MODELS.map((m) => m.provider)).size, 3);
    assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  });

  it('moves an unsupported effort to the nearest level, upwards on a tie', () => {
    assert.equal(effortFor(spec('gemini-3.1-pro-preview'), 'medium'), 'high');
    assert.equal(effortFor(spec('claude-opus-5'), 'low'), 'low');
  });

  it('sends no effort to a model without the control', () => {
    assert.equal(effortFor(spec('claude-haiku-4-5'), 'high'), null);
  });
});

describe('cost', () => {
  it('reproduces the bill of a real Opus 5 read', () => {
    // Measured on production: 268 input, 1,418 output, 34,854 written to cache.
    const cost = costOf(spec('claude-opus-5'), {
      input: 268,
      cacheRead: 0,
      cacheWrite: 34_854,
      output: 1418,
      reasoning: null,
      largestPrompt: 35_122,
    });
    assert.equal(cost.total, 0.254628);
    assert.equal(cost.marginal, 0.054217);
  });

  it('charges Gemini 3.1 Pro its long-context rate above 200k tokens', () => {
    const cost = costOf(spec('gemini-3.1-pro-preview'), {
      input: 250_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1000,
      reasoning: null,
      largestPrompt: 250_000,
    });
    assert.equal(cost.input, 1);
    assert.equal(cost.output, 0.018);
  });
});

describe('keys', () => {
  it('accepts either name for the Google key', () => {
    assert.equal(apiKeysFromEnv({ GOOGLE_API_KEY: 'g' }).google, 'g');
    assert.deepEqual(apiKeysFromEnv({}), {});
  });
});

describe('OpenAI', () => {
  it('sends the file, the instructions, JSON mode and the correction history', () => {
    const body = openaiRequestBody({
      model: 'gpt-5.6-terra',
      system: 'Reply in JSON.',
      filename: 'a.pdf',
      fileId: 'file-1',
      effort: 'high',
      maxOutputTokens: 32_000,
      history: [
        { role: 'assistant', text: '{bad' },
        { role: 'user', text: 'fix it' },
      ],
    }) as { instructions: string; input: { role: string; content: { type: string; file_id?: string; text?: string }[] }[]; [k: string]: unknown };

    assert.equal(body.instructions, 'Reply in JSON.');
    assert.deepEqual(body.input[0]!.content.map((c) => c.type), ['input_file', 'input_text']);
    assert.equal(body.input[0]!.content[0]!.file_id, 'file-1');
    assert.equal(body.input[1]!.role, 'assistant');
    assert.equal(body.input[1]!.content[0]!.type, 'output_text');
    assert.equal(body.input[2]!.content[0]!.type, 'input_text');
    assert.deepEqual(body['text'], { format: { type: 'json_object' } });
    assert.deepEqual(body['reasoning'], { effort: 'high' });
    assert.equal(body['store'], false);
    assert.equal(body['stream'], true);
  });

  it('sends a text document inline and no reasoning key without an effort', () => {
    const body = openaiRequestBody({ model: 'm', system: 's', filename: 'x.txt', text: 'BODY', effort: null, maxOutputTokens: 10, history: [] }) as {
      input: { content: { text?: string }[] }[];
    };
    assert.equal(body.input[0]!.content.length, 1);
    assert.ok(body.input[0]!.content[0]!.text!.endsWith('BODY'));
    assert.ok(!('reasoning' in body));
  });

  it('joins the answer and separates cached input from the rest', () => {
    const turn = parseOpenAIResponse(
      {
        model: 'gpt-5.6-terra-2026-08',
        status: 'completed',
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }] },
        ],
        usage: {
          input_tokens: 40_000,
          input_tokens_details: { cached_tokens: 34_000 },
          output_tokens: 2000,
          output_tokens_details: { reasoning_tokens: 1500 },
        },
      },
      'gpt-5.6-terra',
    );
    assert.equal(turn.text, '{"a":1}');
    assert.equal(turn.usage.input, 6000);
    assert.equal(turn.usage.cacheRead, 34_000);
    assert.equal(turn.usage.output, 2000);
    assert.equal(turn.usage.reasoning, 1500);
    assert.equal(turn.stop, 'end');
    assert.equal(turn.servedModel, 'gpt-5.6-terra-2026-08');
  });

  it('recognises a cut-off reply, a refusal and a failure', () => {
    assert.equal(parseOpenAIResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'm').stop, 'max_tokens');
    const refused = parseOpenAIResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'm');
    assert.equal(refused.stop, 'refused');
    assert.equal(refused.detail, 'no');
    assert.throws(() => parseOpenAIResponse({ status: 'failed', error: { message: 'boom' } }, 'm'), ReaderError);
  });
});

describe('Google', () => {
  it('sends the system instruction, the file and the history with role "model"', () => {
    const body = geminiRequestBody({
      system: 'SYS',
      filename: 'a.pdf',
      documentPart: { fileData: { mimeType: 'application/pdf', fileUri: 'https://example/files/1' } },
      effort: 'low',
      maxOutputTokens: 32_000,
      history: [
        { role: 'assistant', text: '{bad' },
        { role: 'user', text: 'fix it' },
      ],
    }) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: Record<string, unknown>[] }[];
      generationConfig: Record<string, unknown>;
    };
    assert.equal(body.systemInstruction.parts[0]!.text, 'SYS');
    assert.ok(body.contents[0]!.parts[0]!['fileData']);
    assert.equal(body.contents[0]!.parts[1]!['text'], 'File name: a.pdf');
    assert.equal(body.contents[1]!.role, 'model');
    assert.equal(body.contents[2]!.role, 'user');
    assert.equal(body.generationConfig['responseMimeType'], 'application/json');
    assert.deepEqual(body.generationConfig['thinkingConfig'], { thinkingLevel: 'low' });
  });

  it('leaves thought summaries out of the answer and bills thinking as output', () => {
    const turn = parseGeminiChunks(
      [
        { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: '{"a":' }] } }] },
        {
          candidates: [{ content: { parts: [{ text: '1}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 97_000, cachedContentTokenCount: 35_000, candidatesTokenCount: 1200, thoughtsTokenCount: 800 },
          modelVersion: 'gemini-3.8-flash-001',
        },
      ],
      'gemini-3.8-flash',
    );
    assert.equal(turn.text, '{"a":1}');
    assert.equal(turn.usage.input, 62_000);
    assert.equal(turn.usage.cacheRead, 35_000);
    assert.equal(turn.usage.output, 2000);
    assert.equal(turn.usage.reasoning, 800);
    assert.equal(turn.servedModel, 'gemini-3.8-flash-001');
    assert.equal(turn.stop, 'end');
  });

  it('recognises a cut-off reply, a blocked prompt and a safety stop', () => {
    assert.equal(parseGeminiChunks([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }], 'm').stop, 'max_tokens');
    assert.equal(parseGeminiChunks([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }], 'm').stop, 'refused');
    assert.equal(parseGeminiChunks([{ candidates: [{ finishReason: 'SAFETY' }] }], 'm').stop, 'refused');
  });
});

describe('streams', () => {
  it('parses a data line and skips what is not JSON', () => {
    assert.equal(parseBlock('event: x\ndata: {"type":"response.completed"}')?.['type'], 'response.completed');
    assert.equal(parseBlock('data: [DONE]'), null);
    assert.equal(parseBlock(': keep-alive'), null);
  });
});

describe('reading', () => {
  it('reports a missing key as a result, naming the variable', async () => {
    const result = await readAgreement({
      modelId: 'gpt-5.6-terra',
      system: 's',
      schema: {},
      document: { filename: 'a', text: 'x' },
      apiKeys: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'not_configured');
    assert.match(result.error?.message ?? '', /OPENAI_API_KEY/);
  });

  it('reports a model outside the catalog as a result', async () => {
    const result = await readAgreement({ modelId: 'nope', system: 's', schema: {}, document: { filename: 'a', text: 'x' }, apiKeys: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'unknown_model');
  });
});

describe('prompt', () => {
  it('fills every placeholder and cuts the document section', () => {
    const prompt = buildReaderPrompt({
      template: 'Today {{TODAY}}\n{{TAXONOMY}}\n{{SCHEMA}}\n## The document\nDOC',
      schemaText: '{}',
      today: '2026-09-11',
      nodes: [
        { id: 'human_services:food', axis: 'response', depth: 0, name: 'food' },
        { id: 'human_situations:x', axis: 'situation', depth: 1, name: null },
      ],
    });
    assert.match(prompt, /2026-09-11/);
    assert.match(prompt, /human_services:food — food/);
    assert.match(prompt, / {2}human_situations:x — /);
    assert.doesNotMatch(prompt, /DOC|\{\{/);
  });
});
