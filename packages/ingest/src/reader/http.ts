import { ReaderError } from './types.js';

/**
 * HTTP for the providers reached without an SDK.
 *
 * OpenAI and Google are called over their documented REST endpoints with the
 * runtime's own fetch, rather than through two more SDKs whose surfaces would
 * each have to be learned and pinned. What an SDK would otherwise have supplied
 * is here: retrying the failures that are worth retrying, and streaming, so a
 * long read of a scanned tender is not cut off by an idle-connection timeout
 * while the model thinks.
 */

/** Statuses that mean "not now" rather than "not this". */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export async function send(
  url: string,
  init: RequestInit,
  { attempts = 4, what }: { attempts?: number; what: string },
): Promise<Response> {
  let last: ReaderError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      last = new ReaderError(`${what}: ${(err as Error).message}`, 'network');
      await pause(backoff(attempt), init.signal);
      continue;
    }
    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    const message = `${what}: ${res.status} ${describe(body)}`;
    if (!RETRYABLE.has(res.status)) {
      throw new ReaderError(message, kindOf(res.status, body), res.status);
    }
    last = new ReaderError(message, res.status === 429 ? 'rate_limited' : 'unavailable', res.status);
    if (attempt < attempts) {
      const after = Number(res.headers.get('retry-after'));
      await pause(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : backoff(attempt), init.signal);
    }
  }
  throw last ?? new ReaderError(`${what}: failed`, 'unavailable');
}

/**
 * Server-sent events, one parsed `data` payload at a time.
 *
 * Both providers send JSON in `data:` lines separated by blank lines. A payload
 * that is not JSON — a keep-alive comment, the literal `[DONE]` — is skipped
 * rather than treated as a broken stream.
 */
export async function* events(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  const parsed = parseBlock(buffer);
  if (parsed) yield parsed;
}

export function parseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function kindOf(status: number, body: string): ReaderError['kind'] {
  if (status === 401 || status === 403) return 'not_configured';
  if (status === 404 || /model.*(not found|does not exist|not supported)/i.test(body)) return 'unknown_model';
  if (status === 413) return 'too_large';
  return 'rejected';
}

/** The provider's error message, not its whole JSON envelope. */
function describe(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const error = parsed.error;
    const message = typeof error === 'string' ? error : (error?.message ?? parsed.message);
    if (message) return message.slice(0, 500);
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.slice(0, 500);
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 20_000) + Math.floor(Math.random() * 500);
}

function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
