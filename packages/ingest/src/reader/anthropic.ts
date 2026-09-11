import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { ReaderError, type ReaderSession, type SessionOptions, type TurnResult } from './types.js';

/**
 * Anthropic, through its SDK.
 *
 * A PDF under the inline limit travels in the request as base64. Above it the
 * request would pass the API's 32 MB ceiling — a 30 MB scanned tender is 40 MB
 * once encoded — so it is uploaded to the Files API once, referenced by id for
 * every turn, and deleted when the session closes.
 *
 * The prompt is marked for caching. It carries the whole taxonomy and is the
 * same for every document, so within a run it is paid for once.
 */

/** Raw bytes; base64 adds a third, and the prompt and the reply share the 32 MB. */
const INLINE_LIMIT = 15 * 1024 * 1024;

export async function openAnthropic(options: SessionOptions): Promise<ReaderSession> {
  const { spec, system, document, effort, apiKey, maxOutputTokens, signal } = options;
  const client = new Anthropic({ apiKey });
  let fileId: string | null = null;

  const content: Anthropic.ContentBlockParam[] = [];
  if (document.pdf) {
    if (document.pdf.length > INLINE_LIMIT) {
      const uploaded = await client.files.upload(
        { file: await toFile(document.pdf, 'document.pdf', { type: 'application/pdf' }) },
        { signal },
      );
      fileId = uploaded.id;
      content.push({ type: 'document', source: { type: 'file', file_id: fileId } });
    } else {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: document.pdf.toString('base64') },
      });
    }
    content.push({ type: 'text', text: `File name: ${document.filename}` });
  } else {
    content.push({ type: 'text', text: `File name: ${document.filename}\n\n${document.text ?? ''}` });
  }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
  let previous: Anthropic.ContentBlock[] | null = null;

  return {
    async turn(correction?: string): Promise<TurnResult> {
      if (correction !== undefined && previous) {
        // Append-only: the reply goes back exactly as it came.
        messages.push({ role: 'assistant', content: previous });
        messages.push({ role: 'user', content: correction });
      }

      const message = await client.messages
        .stream(
          {
            model: spec.id,
            max_tokens: maxOutputTokens,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            // A model without the effort control also predates adaptive
            // thinking, and rejects both.
            ...(effort ? { thinking: { type: 'adaptive' as const }, output_config: { effort } } : {}),
            messages,
          },
          { signal },
        )
        .finalMessage()
        .catch((err: unknown) => {
          throw asReaderError(err);
        });

      previous = message.content;
      const read = message.usage.cache_read_input_tokens ?? 0;
      const written = message.usage.cache_creation_input_tokens ?? 0;

      return {
        text: message.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(''),
        usage: {
          input: message.usage.input_tokens,
          cacheRead: read,
          cacheWrite: written,
          output: message.usage.output_tokens,
          reasoning: null,
          largestPrompt: message.usage.input_tokens + read + written,
        },
        stop: message.stop_reason === 'refusal' ? 'refused' : message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
        detail:
          message.stop_reason === 'refusal'
            ? (message.stop_details?.category ?? 'declined without a category')
            : undefined,
        servedModel: message.model,
      };
    },

    async close() {
      if (fileId) await client.files.delete(fileId).catch(() => undefined);
    },
  };
}

function asReaderError(err: unknown): unknown {
  if (!(err instanceof Anthropic.APIError)) return err;
  const status = err.status;
  const kind =
    status === 401 || status === 403
      ? 'not_configured'
      : status === 404
        ? 'unknown_model'
        : status === 413
          ? 'too_large'
          : status === 429
            ? 'rate_limited'
            : status && status >= 500
              ? 'unavailable'
              : 'rejected';
  const body = err.error as { error?: { message?: string } } | undefined;
  return new ReaderError(`Anthropic: ${status ?? ''} ${body?.error?.message ?? err.message}`.trim(), kind, status);
}
