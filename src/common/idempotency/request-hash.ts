import { createHash } from 'node:crypto';

/**
 * Request fingerprint for Idempotency-Key reuse checks (API-100-10 AC5, AC6).
 *
 * `sha256` (hex) over the canonical JSON of `[method, path, body]`:
 * - method upper-cased; path = the request URL as received (path and query string);
 * - body = the parsed JSON body with object keys sorted at every level, so `{"a":1,"b":2}` and
 *   `{"b":2,"a":1}` are the same request; no body (or an empty one) counts as `null`.
 * Array order and value types are significant.
 */

/** JSON text with object keys sorted recursively. `undefined` (no body) becomes `null`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : sortKeys(item)));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) sorted[key] = sortKeys(item);
    }
    return sorted;
  }
  return value;
}

export function requestHash(method: string, path: string, body: unknown): string {
  const normalizedBody = body === '' ? null : body;
  return createHash('sha256')
    .update(canonicalJson([method.toUpperCase(), path, normalizedBody]))
    .digest('hex');
}
