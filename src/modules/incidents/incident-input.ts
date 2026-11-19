import { DomainError } from '../../common/errors';

/**
 * Request values as PostgREST would have handed them to the SQL function. PostgREST converts every
 * argument to its SQL type before the function body runs, so a value Postgres refuses (a path id that
 * is not uuid input, text Postgres cannot store) fails before any check of the function, and without
 * a `fn:code`. The API answers those with 422 `validation:invalid_request` and `details.field`, in
 * argument order, before the function's own checks.
 */

const HEX4 = '[0-9a-fA-F]{4}';
/**
 * Postgres `uuid_in` (`string_to_uuid`): 32 hex digits in either case, an optional `-` after any group
 * of four (never two in a row, never at the end), optionally wrapped in `{}`. No whitespace.
 */
const POSTGRES_UUID_INPUT = new RegExp(
  `^(?:\\{(?:${HEX4}-?){7}${HEX4}\\}|(?:${HEX4}-?){7}${HEX4})$`,
);

/** True when Postgres accepts `value` as uuid input (`'<value>'::uuid` does not raise). */
export function isPostgresUuidInput(value: unknown): value is string {
  return typeof value === 'string' && POSTGRES_UUID_INPUT.test(value);
}

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * True when Postgres can hold `value` as text: no NUL character (Postgres text cannot contain one) and
 * no unpaired UTF-16 surrogate (JSON `"\ud800"`: Postgres' JSON parser refuses it; Node would silently
 * turn it into U+FFFD).
 */
export function isPostgresText(value: string): boolean {
  return !value.includes('\u0000') && !UNPAIRED_SURROGATE.test(value);
}

/** 422 `validation:invalid_request` naming the request field. The value is never echoed. */
export function invalidRequest(field: string): DomainError {
  return new DomainError('validation:invalid_request', { details: { field } });
}

/** The `{id}` path parameter of an incident route: valid uuid input, else 422 on field `id`. */
export function requireIncidentId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('id');
  return value;
}

/**
 * `incident_notes` of `PUT /v1/incidents/{id}/notes` (the SQL `p_incident_notes text default null`):
 * missing or null → null (clears the note); a string Postgres can hold → as is (trimming and the
 * length check run in Postgres). Anything else is 422 on field `incident_notes`: PostgREST would store
 * the JSON text of a number, boolean or object as the note, and that text (`1.50`, `{"a": 1}`) is no
 * longer known once the body is parsed, so the API refuses it rather than store something different.
 */
export function notesFromBody(body: unknown): string | null {
  const value = requireJsonObject(body).incident_notes;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isPostgresText(value)) throw invalidRequest('incident_notes');
  return value;
}

/**
 * The JSON request body of a write route: a JSON object, else 422 on field `body`. Keys the route
 * does not know are ignored (as `POST /v1/incidents` does); a missing key is SQL `null`, like a
 * PostgREST argument that was left out (every optional argument defaults to `null`).
 */
export function requireJsonObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body');
  }
  return body as Record<string, unknown>;
}
