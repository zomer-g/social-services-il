import type { Effort, ModelSpec, Usage } from './models.js';

/** One document, as it arrives: PDF bytes or text, never both. */
export interface ReaderDocument {
  filename: string;
  pdf?: Buffer | undefined;
  text?: string | undefined;
}

/** One reply from a model, normalised across providers. */
export interface TurnResult {
  text: string;
  usage: Usage;
  /**
   * Why the reply ended. `refused` covers every way a provider declines — a
   * refusal, a safety block, a content filter — because to the reader they are
   * the same outcome: this model will not read this document.
   */
  stop: 'end' | 'max_tokens' | 'refused';
  /** The provider's own words for a stop that was not the ordinary end. */
  detail?: string | undefined;
  /** The model the provider says answered, which can be a dated version of the one asked for. */
  servedModel: string;
}

/**
 * A conversation about one document with one model.
 *
 * The first turn sends the document; a later turn sends a correction and the
 * session carries its own history in its provider's shape, so the loop that
 * validates answers does not need to know three message formats.
 */
export interface ReaderSession {
  turn(correction?: string): Promise<TurnResult>;
  /** Deletes whatever was uploaded to the provider for this document. Never throws. */
  close(): Promise<void>;
}

export interface SessionOptions {
  spec: ModelSpec;
  system: string;
  document: ReaderDocument;
  effort: Effort | null;
  apiKey: string;
  maxOutputTokens: number;
  signal?: AbortSignal | undefined;
}

export type ReaderErrorKind =
  | 'not_configured'
  | 'unknown_model'
  | 'rejected'
  | 'rate_limited'
  | 'unavailable'
  | 'too_large'
  | 'network';

/**
 * A failure that belongs to the provider rather than to the answer: a missing
 * key, a request it would not take, a model it does not have, an outage. Kept
 * apart from "the model answered badly", which is a result, not an error.
 */
export class ReaderError extends Error {
  constructor(
    message: string,
    readonly kind: ReaderErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ReaderError';
  }
}
