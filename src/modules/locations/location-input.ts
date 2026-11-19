import { invalidRequest, isPostgresText, requireJsonObject } from '../incidents/incident-input';

/**
 * The body of `POST /v1/incidents/{id}/locations` turned into the arguments PostgREST would pass to
 * `attach_incident_location`, as Postgres input text. PostgREST hands each JSON value to the type's
 * input function (`json_to_record`): a JSON number or a numeric string both reach `float8in`, an ISO
 * (or any other Postgres) date string reaches `timestamptz_in`. The API does the same: values go to
 * Postgres as text and Postgres parses them, so `" 9.03 "`, `"NaN"`, `"Infinity"`, `"now"` or a time
 * without an offset (read as UTC) behave exactly as through PostgREST. Only Postgres can judge some of
 * them, so those are returned as `check`s for `pg_input_is_valid`.
 */

/** Postgres types of the arguments that need a `pg_input_is_valid` check. */
export type PostgresInputType = 'double precision' | 'timestamp with time zone';

export type AttachLocationField =
  | 'location_source'
  | 'location_lat'
  | 'location_lng'
  | 'location_accuracy_m'
  | 'location_captured_at';

/** The argument as Postgres input text (null = SQL null). */
export interface AttachLocationArgs {
  source: string | null;
  lat: string | null;
  lng: string | null;
  accuracy: string | null;
  capturedAt: string | null;
}

/**
 * One argument's conversion result, in argument order: `ok`, `invalid` (Postgres would refuse it for
 * sure), or `check` (Postgres decides: `pg_input_is_valid(text, type)`).
 */
export type ArgumentConversion =
  | { field: AttachLocationField; state: 'ok' }
  | { field: AttachLocationField; state: 'invalid' }
  | { field: AttachLocationField; state: 'check'; text: string; type: PostgresInputType };

export interface ParsedAttachLocation {
  args: AttachLocationArgs;
  /** Every argument, in the SQL function's parameter order. */
  conversions: ArgumentConversion[];
}

type Converted = { text: string | null; conversion: ArgumentConversion };

/**
 * `p_location_source text`. Any JSON value converts to text, and a non-string never equals one of
 * the three sources, so it ends as `invalid_source` in the function's own check. Its JSON text is
 * passed (as PostgREST would); only text Postgres cannot hold fails here.
 */
function textArgument(field: AttachLocationField, value: unknown): Converted {
  if (value === undefined || value === null)
    return { text: null, conversion: { field, state: 'ok' } };
  if (typeof value === 'string') {
    return isPostgresText(value)
      ? { text: value, conversion: { field, state: 'ok' } }
      : { text: null, conversion: { field, state: 'invalid' } };
  }
  return { text: JSON.stringify(value), conversion: { field, state: 'ok' } };
}

/**
 * A finite JSON number as `float8` input that parses to the same double. `-0` keeps its sign (as
 * `float8in("-0")` does). Infinity only comes from an out-of-range literal such as `1e400`, which
 * `float8in` refuses.
 */
function float8Text(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return Object.is(value, -0) ? '-0' : String(value);
}

/** `p_location_lat` / `_lng` / `_accuracy_m double precision`. */
function floatArgument(field: AttachLocationField, value: unknown): Converted {
  if (value === undefined || value === null)
    return { text: null, conversion: { field, state: 'ok' } };
  if (typeof value === 'number') {
    const text = float8Text(value);
    return text === null
      ? { text: null, conversion: { field, state: 'invalid' } }
      : { text, conversion: { field, state: 'ok' } };
  }
  if (typeof value === 'string' && isPostgresText(value)) {
    return {
      text: value,
      conversion: { field, state: 'check', text: value, type: 'double precision' },
    };
  }
  // A boolean, object or array: `float8in('true')` / `float8in('{...}')` always refuses it.
  return { text: null, conversion: { field, state: 'invalid' } };
}

/**
 * `p_location_captured_at timestamptz`: a string is checked by Postgres. Other JSON values are refused
 * (a choice, not PostgREST's behaviour): PostgREST would hand the number's literal text (`20261119`
 * parses as a date) to `timestamptz_in`, and that text is gone once the body is parsed.
 */
function timestampArgument(field: AttachLocationField, value: unknown): Converted {
  if (value === undefined || value === null)
    return { text: null, conversion: { field, state: 'ok' } };
  if (typeof value === 'string' && isPostgresText(value)) {
    return {
      text: value,
      conversion: { field, state: 'check', text: value, type: 'timestamp with time zone' },
    };
  }
  return { text: null, conversion: { field, state: 'invalid' } };
}

/**
 * Reads the body (a JSON object, else 422 on field `body`). Missing and `null` are the same: SQL null,
 * the argument's default. Keys the route does not know are ignored.
 */
export function parseAttachLocationBody(body: unknown): ParsedAttachLocation {
  const object = requireJsonObject(body);
  const source = textArgument('location_source', object.location_source);
  const lat = floatArgument('location_lat', object.location_lat);
  const lng = floatArgument('location_lng', object.location_lng);
  const accuracy = floatArgument('location_accuracy_m', object.location_accuracy_m);
  const capturedAt = timestampArgument('location_captured_at', object.location_captured_at);
  return {
    args: {
      source: source.text,
      lat: lat.text,
      lng: lng.text,
      accuracy: accuracy.text,
      capturedAt: capturedAt.text,
    },
    conversions: [
      source.conversion,
      lat.conversion,
      lng.conversion,
      accuracy.conversion,
      capturedAt.conversion,
    ],
  };
}

/**
 * The first argument Postgres refuses, in parameter order, given the `pg_input_is_valid` results of
 * the `check`s (same order as they appear in `conversions`). Throws 422 `validation:invalid_request`
 * naming it; returns when every argument converts.
 */
export function assertArgumentsConvert(
  conversions: readonly ArgumentConversion[],
  checkResults: readonly boolean[],
): void {
  let next = 0;
  for (const conversion of conversions) {
    if (conversion.state === 'invalid') throw invalidRequest(conversion.field);
    if (conversion.state === 'check' && checkResults[next++] !== true) {
      throw invalidRequest(conversion.field);
    }
  }
}

/** The `check` conversions, in order: what `pg_input_is_valid` must judge. */
export function pendingChecks(
  conversions: readonly ArgumentConversion[],
): Extract<ArgumentConversion, { state: 'check' }>[] {
  return conversions.filter(
    (c): c is Extract<ArgumentConversion, { state: 'check' }> => c.state === 'check',
  );
}
