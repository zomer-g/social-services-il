import type { Effort } from './models.js';
import { events, send } from './http.js';
import { ReaderError, type ReaderSession, type SessionOptions, type TurnResult } from './types.js';

/**
 * OpenAI, through the Responses API.
 *
 * A PDF is uploaded to the Files API with purpose `user_data` and referenced by
 * id, whatever its size: OpenAI reads the page images and the text layer both,
 * and one path for every document is one path to get right. It is deleted when
 * the session closes.
 *
 * JSON mode, not structured outputs, for the same reason as at the other two
 * providers: the schema is too large to compile, and a comparison is only fair
 * if every model is held to the shape the same way — by the prompt, and by the
 * same validator afterwards.
 *
 * `store: false`, so nothing about the document is kept on OpenAI's side beyond
 * the upload this session deletes. The conversation is resent in full on a
 * correction instead of being referenced by id.
 */

const BASE = 'https://api.openai.com/v1';

/** Shared across documents so the cached prompt is found again. */
const CACHE_KEY = 'ssil-agreement-reader';

export interface OpenAIHistoryItem {
  role: 'assistant' | 'user';
  text: string;
}

/** The request body. Pure, so its shape can be checked without a network. */
export function openaiRequestBody(input: {
  model: string;
  system: string;
  filename: string;
  fileId?: string | null | undefined;
  text?: string | undefined;
  effort: Effort | null;
  maxOutputTokens: number;
  history: OpenAIHistoryItem[];
}): Record<string, unknown> {
  const first: Record<string, unknown>[] = [];
  if (input.fileId) first.push({ type: 'input_file', file_id: input.fileId });
  first.push({
    type: 'input_text',
    text: input.text === undefined ? `File name: ${input.filename}` : `File name: ${input.filename}\n\n${input.text}`,
  });

  return {
    model: input.model,
    instructions: input.system,
    input: [
      { role: 'user', content: first },
      ...input.history.map((item) => ({
        role: item.role,
        content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text }],
      })),
    ],
    max_output_tokens: input.maxOutputTokens,
    text: { format: { type: 'json_object' } },
    ...(input.effort ? { reasoning: { effort: input.effort } } : {}),
    prompt_cache_key: CACHE_KEY,
    store: false,
    stream: true,
  };
}

interface ResponseObject {
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/** A finished response object, normalised. Pure. */
export function parseOpenAIResponse(response: ResponseObject, requested: string): TurnResult {
  if (response.status === 'failed') {
    throw new ReaderError(`OpenAI: ${response.error?.message ?? 'the response failed'}`, 'rejected');
  }

  const parts = (response.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
  const text = parts
    .filter((p) => p.type === 'output_text')
    .map((p) => p.text ?? '')
    .join('');
  const refusal = parts.find((p) => p.type === 'refusal')?.refusal;
  const reason = response.incomplete_details?.reason;

  const prompt = response.usage?.input_tokens ?? 0;
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;

  return {
    text,
    usage: {
      // OpenAI reports what was read from the cache but not what was written
      // to it. The uncached remainder is billed here at the ordinary rate, so
      // on a GPT-5.6 model the first document of a run is understated by the
      // quarter-rate write surcharge on the prompt — cents, and never after.
      input: Math.max(prompt - cached, 0),
      cacheRead: cached,
      cacheWrite: 0,
      output: response.usage?.output_tokens ?? 0,
      reasoning: response.usage?.output_tokens_details?.reasoning_tokens ?? null,
      largestPrompt: prompt,
    },
    stop: refusal || reason === 'content_filter' ? 'refused' : reason === 'max_output_tokens' ? 'max_tokens' : 'end',
    detail: refusal ?? (reason && reason !== 'max_output_tokens' ? reason : undefined),
    servedModel: response.model ?? requested,
  };
}

export async function openOpenAI(options: SessionOptions): Promise<ReaderSession> {
  const { spec, system, document, effort, apiKey, maxOutputTokens, signal } = options;
  const auth = { authorization: `Bearer ${apiKey}` };
  let fileId: string | null = null;

  if (document.pdf) {
    const form = new FormData();
    form.append('purpose', 'user_data');
    // An ASCII name for the upload; the real one, which may well be Hebrew,
    // travels in the text beside it where it cannot upset a multipart parser.
    form.append('file', new Blob([new Uint8Array(document.pdf)], { type: 'application/pdf' }), 'document.pdf');
    const res = await send(`${BASE}/files`, { method: 'POST', headers: auth, body: form, signal }, { what: 'OpenAI upload' });
    fileId = ((await res.json()) as { id: string }).id;
  }

  const history: OpenAIHistoryItem[] = [];
  let lastText = '';

  return {
    async turn(correction?: string): Promise<TurnResult> {
      if (correction !== undefined) {
        history.push({ role: 'assistant', text: lastText }, { role: 'user', text: correction });
      }

      const body = openaiRequestBody({
        model: spec.id,
        system,
        filename: document.filename,
        fileId,
        text: document.pdf ? undefined : (document.text ?? ''),
        effort,
        maxOutputTokens,
        history,
      });

      const res = await send(
        `${BASE}/responses`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal,
        },
        { what: `OpenAI ${spec.id}` },
      );

      let final: ResponseObject | null = null;
      for await (const event of events(res)) {
        const type = event['type'];
        if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
          final = event['response'] as ResponseObject;
        } else if (type === 'error') {
          const message = (event['message'] as string | undefined) ?? JSON.stringify(event).slice(0, 300);
          throw new ReaderError(`OpenAI ${spec.id}: ${message}`, 'rejected');
        }
      }
      if (!final) throw new ReaderError(`OpenAI ${spec.id}: the stream ended without a response`, 'unavailable');

      const result = parseOpenAIResponse(final, spec.id);
      lastText = result.text;
      return result;
    },

    async close() {
      if (!fileId) return;
      await fetch(`${BASE}/files/${fileId}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
    },
  };
}
