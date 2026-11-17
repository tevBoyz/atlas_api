import type { ErrorCode } from './error-codes';
import { messageForCode } from './error-messages';
import { httpStatusForCode } from './http-status';

/** JSON-safe extra data for the envelope `details` (e.g. `{ field }`, LockoutStatus). No personal data. */
export type ErrorDetails = Record<string, unknown>;

export interface DomainErrorOptions {
  /** Envelope `details`. Defaults to `{}`. */
  details?: ErrorDetails;
  /** Sets the `Retry-After` header (seconds), for `rate_limited` (spec §11.2). */
  retryAfterSeconds?: number;
  /** Underlying error, kept for logs only (never sent to the client). */
  cause?: unknown;
}

/**
 * An expected failure with a catalogue code (story API-100-05 AC2). Throw it from any layer; the
 * global exception filter turns it into the envelope with the status from the §11.2 table.
 * The message is always the fixed catalogue text (AC6): callers cannot pass free text.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: DomainErrorOptions = {}) {
    super(messageForCode(code), options.cause === undefined ? undefined : { cause: options.cause });
    const status = httpStatusForCode(code);
    if (status === undefined) {
      // Unreachable for catalogue codes (a unit test maps every one); guards against casts.
      throw new Error(`Error code without an HTTP status mapping: ${code}`);
    }
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = options.details ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
