import type { Effort } from './models.js';
import { events, send } from './http.js';
import { ReaderError, type ReaderSession, type SessionOptions, type TurnResult } from './types.js';

/**
 * Google, through the Gemini API's generateContent.
 *
 * A PDF under the inline limit travels in the request. Above it, the request
 * would pass the 20 MB inline ceiling, so it goes up through the File API's
 * resumable upload, is waited on until Google has finished processing it, and
 * is deleted when the session closes (Google would otherwise keep it for two
 * days).
 *
 * The media resolution is left at its default, which for a PDF page is 560
 * tokens — the level Google's own guidance says OCR quality saturates at, and
 * the reason a scanned tender costs a fraction here of what it costs elsewhere.
 * Raising it would make the comparison measure a different, dearer setting.
 */

const BASE = 'https://generativelanguage.googleapis.com';

/** Raw bytes; base64 adds a third and the whole request must stay under 20 MB. */
const INLINE_LIMIT = 14 * 1024 * 1024;

/** How long an upload may stay in PROCESSING before the read is given up. */
const PROCESSING_TIMEOUT_MS = 3 * 60 * 1000;

export interface GeminiHistoryItem {
  role: 'assistant' | 'user';
  text: string;
}

export type GeminiDocumentPart =
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

/** The request body. Pure, so its shape can be checked without a network. */
export function geminiRequestBody(input: {
  system: string;
  filename: string;
  documentPart?: GeminiDocumentPart | null | undefined;
  text?: string | undefined;
  effort: Effort | null;
  maxOutputTokens: number;
  history: GeminiHistoryItem[];
}): Record<string, unknown> {
  const first: Record<string, unknown>[] = [];
  if (input.documentPart) first.push(input.documentPart);
  first.push({
    text: input.text === undefined ? `File name: ${input.filename}` : `File name: ${input.filename}\n\n${input.text}`,
  });

  return {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: [
      { role: 'user', parts: first },
      ...input.history.map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.text }] })),
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: input.maxOutputTokens,
      ...(input.effort ? { thinkingConfig: { thinkingLevel: input.effort } } : {}),
    },
  };
}

interface Chunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

/** Finish reasons that mean the model would not, rather than could not, go on. */
const DECLINED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

/** A stream of chunks, normalised. Pure. */
export function parseGeminiChunks(chunks: Chunk[], requested: string): TurnResult {
  const text = chunks
    .flatMap((c) => c.candidates?.[0]?.content?.parts ?? [])
    // Thought summaries arrive as parts flagged `thought`; they are not the answer.
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  const blocked = chunks.find((c) => c.promptFeedback?.blockReason)?.promptFeedback?.blockReason;
  const finish = [...chunks].reverse().find((c) => c.candidates?.[0]?.finishReason)?.candidates?.[0]?.finishReason;
  // Each chunk carries the running totals; the last one is the whole reply.
  const usage = [...chunks].reverse().find((c) => c.usageMetadata)?.usageMetadata ?? {};
  const prompt = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount ?? null;

  return {
    text,
    usage: {
      input: Math.max(prompt - cached, 0),
      cacheRead: cached,
      cacheWrite: 0,
      // Thinking is billed as output, and reported beside it rather than in it.
      output: (usage.candidatesTokenCount ?? 0) + (thoughts ?? 0),
      reasoning: thoughts,
      largestPrompt: prompt,
    },
    stop: blocked || (finish && DECLINED.has(finish)) ? 'refused' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end',
    detail: blocked ?? (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS' ? finish : undefined),
    servedModel: [...chunks].reverse().find((c) => c.modelVersion)?.modelVersion ?? requested,
  };
}

export async function openGoogle(options: SessionOptions): Promise<ReaderSession> {
  const { spec, system, document, effort, apiKey, maxOutputTokens, signal } = options;
  const auth = { 'x-goog-api-key': apiKey };
  let fileName: string | null = null;
  let documentPart: GeminiDocumentPart | null = null;

  if (document.pdf) {
    if (document.pdf.length <= INLINE_LIMIT) {
      documentPart = { inlineData: { mimeType: 'application/pdf', data: document.pdf.toString('base64') } };
    } else {
      const file = await upload(document.pdf, auth, signal);
      fileName = file.name;
      documentPart = { fileData: { mimeType: 'application/pdf', fileUri: file.uri } };
    }
  }

  const history: GeminiHistoryItem[] = [];
  let lastText = '';

  return {
    async turn(correction?: string): Promise<TurnResult> {
      if (correction !== undefined) {
        history.push({ role: 'assistant', text: lastText }, { role: 'user', text: correction });
      }

      const body = geminiRequestBody({
        system,
        filename: document.filename,
        documentPart,
        text: document.pdf ? undefined : (document.text ?? ''),
        effort,
        maxOutputTokens,
        history,
      });

      const res = await send(
        `${BASE}/v1beta/models/${encodeURIComponent(spec.id)}:streamGenerateContent?alt=sse`,
        { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body), signal },
        { what: `Gemini ${spec.id}` },
      );

      const chunks: Chunk[] = [];
      for await (const event of events(res)) {
        if (event['error']) {
          const error = event['error'] as { message?: string };
          throw new ReaderError(`Gemini ${spec.id}: ${error.message ?? 'stream error'}`, 'rejected');
        }
        chunks.push(event as Chunk);
      }
      if (chunks.length === 0) throw new ReaderError(`Gemini ${spec.id}: the stream was empty`, 'unavailable');

      const result = parseGeminiChunks(chunks, spec.id);
      lastText = result.text;
      return result;
    },

    async close() {
      if (!fileName) return;
      await fetch(`${BASE}/v1beta/${fileName}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
    },
  };
}

interface UploadedFile {
  name: string;
  uri: string;
  state?: string;
}

async function upload(bytes: Buffer, auth: Record<string, string>, signal?: AbortSignal): Promise<UploadedFile> {
  const start = await send(
    `${BASE}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        ...auth,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.length),
        'X-Goog-Upload-Header-Content-Type': 'application/pdf',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'document.pdf' } }),
      signal,
    },
    { what: 'Gemini upload' },
  );
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new ReaderError('Gemini upload: no upload URL was returned', 'unavailable');

  const done = await send(
    uploadUrl,
    {
      method: 'POST',
      headers: { ...auth, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: new Uint8Array(bytes),
      signal,
    },
    { what: 'Gemini upload', attempts: 1 },
  );
  let file = ((await done.json()) as { file: UploadedFile }).file;

  // A PDF is processed before it can be read; asking too early is an error.
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new ReaderError('Gemini upload: still processing after three minutes', 'unavailable');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const res = await send(`${BASE}/v1beta/${file.name}`, { headers: auth, signal }, { what: 'Gemini upload status' });
    file = (await res.json()) as UploadedFile;
  }
  if (file.state === 'FAILED') throw new ReaderError('Gemini upload: Google could not process this file', 'rejected');
  return file;
}
