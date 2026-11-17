import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Request header carrying the request id, in and out (story API-100-06 AC1). */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Accepted incoming ids: 1-128 characters from `A-Z a-z 0-9 . _ : -` (covers UUIDs, ULIDs and
 * typical proxy/load-balancer ids). Anything else (too long, spaces, control characters, quotes)
 * is ignored and a fresh UUID is used, so a client cannot inject text into logs or headers.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The incoming id when it is acceptable, else a new UUID v4. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

/**
 * Fastify `genReqId`. Also stores the id on the raw request (`req.id`), which pino-http reuses, so
 * Fastify's `request.id`, the response header and every log line carry the same value.
 */
export function genRequestId(raw: IncomingMessage): string {
  const id = resolveRequestId(raw.headers[REQUEST_ID_HEADER]);
  (raw as IncomingMessage & { id?: string }).id = id;
  return id;
}
