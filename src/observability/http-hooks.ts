import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { REQUEST_ID_LOG_KEY } from './logger';
import { REQUEST_ID_HEADER } from './request-id';

/**
 * A child of the root logger bound to the request id. Used where the nestjs-pino request context
 * may not exist (Fastify hooks, unmatched routes, body-parse errors).
 */
export function requestLogger(request: FastifyRequest, root: Logger): Logger {
  return root.child({ [REQUEST_ID_LOG_KEY]: request.id });
}

/** Fields of the per-request completion log line. Route template only: never the raw URL or query. */
export function completionFields(request: FastifyRequest, reply: FastifyReply) {
  return {
    method: request.method,
    route: request.routeOptions?.url ?? null,
    status_code: reply.statusCode,
    duration_ms: Math.round(reply.elapsedTime * 10) / 10,
  };
}

/** Fastify route-config key that marks a route's completion line as debug-level (API-100-07 AC3). */
export const QUIET_REQUEST_LOG = 'atlasQuietRequestLog';

/**
 * Logs this route's `request completed` line at debug instead of info/error, whatever the status.
 * For high-frequency probe routes (health, readiness), polled by load balancers every few seconds.
 * Sets the route's Fastify `config`, so do not combine it with another `@RouteConfig` on one handler.
 */
export const QuietRequestLog = () => RouteConfig({ [QUIET_REQUEST_LOG]: true });

/** True when the matched route was marked with {@link QuietRequestLog}. */
export function isQuietRoute(request: FastifyRequest): boolean {
  const config = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
  return config?.[QUIET_REQUEST_LOG] === true;
}

/**
 * Fastify hooks for every request, matched or not (story API-100-06 AC1, AC5):
 * - `onRequest`: echo the request id in the `x-request-id` response header (errors and 404s too).
 * - `onResponse`: one `request completed` line with method, route template, status and duration.
 *   Bodies, headers and query strings are never logged. Routes marked {@link QuietRequestLog}
 *   (health, readiness) log that line at debug only.
 */
export function installHttpHooks(fastify: FastifyInstance, root: Logger): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const fields = completionFields(request, reply);
    const log = requestLogger(request, root);
    if (isQuietRoute(request)) log.debug(fields, 'request completed');
    else if (reply.statusCode >= 500) log.error(fields, 'request completed');
    else log.info(fields, 'request completed');
    done();
  });
}
