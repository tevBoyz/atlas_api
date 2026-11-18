import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';

import { API_PREFIX, UNPREFIXED_ROUTES } from './app.constants';
import { installRequestContext } from './common/http/request-context';
import { IdempotencyHookInstaller } from './common/idempotency';
import { ApiConfigService, fastifyTrustProxy, type TrustProxy } from './config';
import { genRequestId, installHttpHooks, ROOT_LOGGER } from './observability';

/**
 * The Fastify adapter used by main.ts and by tests, so both behave the same.
 * - Request id: incoming `x-request-id` when valid, else a UUID (API-100-06 AC1).
 * - Fastify's own logger stays off (its default): logging goes through nestjs-pino and `installHttpHooks`.
 */
export function createFastifyAdapter(options: { trustProxy?: TrustProxy } = {}): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: fastifyTrustProxy(options.trustProxy ?? false),
    genReqId: genRequestId,
    requestIdHeader: false,
  });
}

/** Shared app setup, used by main.ts and by tests so both see the same routing and hooks. */
export function configureApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  const fastify = app.getHttpAdapter().getInstance();
  installHttpHooks(fastify, app.get<Logger>(ROOT_LOGGER));
  // Request id and client IP for code that has no request object, e.g. the audit log (API-100-14).
  installRequestContext(fastify, app.get(ApiConfigService).get('TRUST_PROXY'));
  // Records responses of `@Idempotent()` routes (API-100-10).
  app.get(IdempotencyHookInstaller).install(fastify);
}
