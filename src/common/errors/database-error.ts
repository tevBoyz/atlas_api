import {
  type ErrorPrefix,
  isErrorCode,
  PARITY_ERROR_CODES,
  type ParityErrorCode,
} from './error-codes';
import { DomainError } from './domain-error';

/** SQLSTATE of `raise exception` in PL/pgSQL (all Atlas business errors, spec §7). */
export const RAISE_EXCEPTION_SQLSTATE = 'P0001';

/**
 * Raw (unprefixed) messages raised by triggers, mapped to `<operation>:<message>` (AC3).
 * Today only `enforce_safety_circle_member_capacity` raises one: `circle_full`.
 */
export const RAW_TRIGGER_MESSAGES = ['circle_full'] as const;

interface PgRaise {
  code: string;
  message: string;
}

function isPgRaise(value: unknown): value is PgRaise {
  return (
    value instanceof Error &&
    (value as { code?: unknown }).code === RAISE_EXCEPTION_SQLSTATE &&
    typeof value.message === 'string'
  );
}

/** Finds the node-postgres error, also when wrapped (e.g. Drizzle's query error `cause`). */
function findPgRaise(error: unknown): PgRaise | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (isPgRaise(current)) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function prefixHas(prefix: ErrorPrefix, suffix: string): boolean {
  return (PARITY_ERROR_CODES[prefix] as readonly string[]).includes(suffix);
}

/**
 * Turns a database `raise exception` into a {@link DomainError}, or returns `undefined` when it is
 * not a known business error (the caller then treats it as unexpected → 500).
 * - `fn:code` messages from the SQL functions (still called during the transition) map as-is when
 *   the code is in the catalogue.
 * - The raw trigger message `circle_full` maps to `<operation>:circle_full` when the operation has
 *   that code (story API-100-05 AC3).
 */
export function domainErrorFromDatabase(
  error: unknown,
  operation: ErrorPrefix | undefined,
): DomainError | undefined {
  const raise = findPgRaise(error);
  if (!raise) return undefined;
  const message = raise.message.trim();
  if (isErrorCode(message)) return new DomainError(message, { cause: error });
  if ((RAW_TRIGGER_MESSAGES as readonly string[]).includes(message) && operation) {
    if (prefixHas(operation, message)) {
      return new DomainError(`${operation}:${message}` as ParityErrorCode, { cause: error });
    }
  }
  return undefined;
}
