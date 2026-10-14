import { z } from 'zod';
import type { SharedTool } from './tools.js';

/**
 * A bounded tool-use loop against Gemini's REST API — the same shape as the
 * Anthropic loop in smart search, so either provider can answer it.
 *
 * Called directly over fetch, as the agreements reader does, rather than
 * through another SDK: the request is small and its shape is checked here.
 */

const BASE = 'https://generativelanguage.googleapis.com';

/** Low latency matters more than depth: this picks categories and runs a search. */
export const GEMINI_SMART_MODEL = 'gemini-3.8-flash';

/** Finish reasons that mean the model would not, rather than could not, go on. */
const DECLINED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']);

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  [key: string]: unknown;
}

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** The tools as Gemini declares them. The `$schema` marker is dropped: it describes the document, not the parameters. */
export function geminiFunctions(tools: SharedTool[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(z.object(tool.schema)) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, parametersJsonSchema: parameters };
  });
}

export interface ToolLoopResult {
  declined: boolean;
  answer: string;
}

export async function geminiToolLoop(input: {
  apiKey: string;
  model?: string;
  system: string;
  userText: string;
  tools: SharedTool[];
  maxTurns: number;
  maxOutputTokens: number;
  /** Runs one tool and returns what goes back to the model. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: unknown; isError: boolean }>;
}): Promise<ToolLoopResult> {
  const model = input.model ?? GEMINI_SMART_MODEL;
  const functionDeclarations = geminiFunctions(input.tools);

  const contents: Content[] = [{ role: 'user', parts: [{ text: input.userText }] }];
  let answer = '';

  for (let turn = 0; turn < input.maxTurns; turn += 1) {
    const res = await fetch(`${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': input.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { maxOutputTokens: input.maxOutputTokens, thinkingConfig: { thinkingLevel: 'low' } },
      }),
    });
    const body = (await res.json().catch(() => null)) as (GenerateResponse & { error?: { message?: string } }) | null;
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${body?.error?.message ?? res.statusText}`);
    }

    if (body?.promptFeedback?.blockReason) return { declined: true, answer: '' };
    const candidate = body?.candidates?.[0];
    if (candidate?.finishReason && DECLINED.has(candidate.finishReason)) return { declined: true, answer: '' };

    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text && !part.thought) answer += part.text;
    }

    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) break;

    // The model's turn goes back verbatim: Gemini 3 attaches a thought
    // signature to function calls and rejects a history that drops it.
    contents.push({ role: 'model', parts });

    const responses: Part[] = [];
    for (const part of calls) {
      const call = part.functionCall!;
      const { content, isError } = await input.callTool(call.name, call.args ?? {});
      responses.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: isError ? { error: content } : { result: content },
        },
      });
    }
    // All responses in one turn, as with the Anthropic loop.
    contents.push({ role: 'user', parts: responses });
  }

  return { declined: false, answer };
}
