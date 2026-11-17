import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { from, type Observable, of, switchMap } from 'rxjs';

import { requestLogger } from '../../observability/http-hooks';
import { ROOT_LOGGER } from '../../observability/logger';
import { getRequestUser, NoAuthenticatedUserError } from '../auth/authenticated-user';
import { DomainError } from '../errors/domain-error';
import { IdempotencyStore, type IdempotencyClaim } from './idempotency.store';
import { IDEMPOTENCY_METADATA, type IdempotencyMode } from './idempotent.decorator';
import { requestHash } from './request-hash';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

/** Any RFC 4122 shaped UUID (the app sends v4). Compared lower-cased. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claims held by in-flight requests, finished by the onSend hook. */
const requestClaims = new WeakMap<object, IdempotencyClaim>();

/** The `Idempotency-Key` of a request: undefined when absent/blank; throws 422 when not a UUID. */
export function idempotencyKeyOf(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') throw new DomainError('idempotency:invalid_key');
  const value = header.trim();
  if (value.length === 0) return undefined;
  if (!UUID.test(value)) throw new DomainError('idempotency:invalid_key');
  return value.toLowerCase();
}

/**
 * Idempotency-Key handling for `@Idempotent()` routes (API-100-10). A global interceptor, so it runs
 * after the guards (the caller is known: keys are per user) and before pipes and the handler.
 *
 * - AC3: missing key on a `required` route → 400 `idempotency:key_required`; not a UUID → 422
 *   `idempotency:invalid_key`. On an `optional` route a missing key means "no idempotency".
 * - AC4: first use claims the key (`in_progress`) and runs the handler; the onSend hook
 *   ({@link installIdempotencyHook}) stores the response actually sent and marks it `completed`.
 * - AC5: replay of a completed key with the same method, path and body → the stored status and
 *   body with `Idempotent-Replayed: true`; the handler does not run.
 * - AC6: same key, different method/path/body → 422 `idempotency:key_mismatch`.
 * - AC7: still `in_progress` → 409 `idempotency:in_progress` + `Retry-After: 1`; older than 60 s →
 *   abandoned, the request runs again.
 * - AC8: 2xx and 4xx responses are stored (also error envelopes from the handler, pipes and the
 *   exception filter); 5xx releases the key.
 * - AC9: keys expire after 24 h (purge on read + opportunistic sweep).
 * - AC10: domain idempotency in the operations stays underneath (this is only the outer layer).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const mode = this.reflector.getAllAndOverride<IdempotencyMode | undefined>(
      IDEMPOTENCY_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!mode) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const key = idempotencyKeyOf(request.headers[IDEMPOTENCY_KEY_HEADER]);
    if (key === undefined) {
      if (mode === 'required') throw new DomainError('idempotency:key_required');
      return next.handle();
    }
    const user = getRequestUser(request);
    if (!user) throw new NoAuthenticatedUserError();

    const method = request.method.toUpperCase();
    const path = request.url;
    return from(
      this.store.claim({
        userId: user.id,
        key,
        method,
        path,
        requestHash: requestHash(method, path, request.body),
      }),
    ).pipe(
      switchMap((outcome) => {
        switch (outcome.kind) {
          case 'claimed':
            requestClaims.set(request, outcome.claim);
            return next.handle();
          case 'replay':
            void reply.status(outcome.status).header(IDEMPOTENT_REPLAYED_HEADER, 'true');
            return of(outcome.body ?? undefined);
          case 'mismatch':
            throw new DomainError('idempotency:key_mismatch');
          case 'in_progress':
            throw new DomainError('idempotency:in_progress', { retryAfterSeconds: 1 });
        }
      }),
    );
  }
}

function payloadText(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return undefined; // a stream: not storable
}

function isJsonContentType(value: unknown): boolean {
  return typeof value === 'string' && /^application\/(?:[\w.+-]+\+)?json\b/i.test(value);
}

/**
 * Finishes a claim when its response is sent (Fastify `onSend`), so what is stored is exactly what
 * the client received, including the exception filter's error envelope:
 * - 2xx / 4xx with a JSON (or empty) body → `completed` with status and body;
 * - anything else (5xx, a non-JSON or streamed body) → the claim is released (key retryable).
 * The write is awaited before the response leaves, so a retry after the response finds it.
 * A failed write is logged and the response still goes out (the claim then expires as abandoned
 * after 60 s; domain idempotency protects the rerun).
 */
export function installIdempotencyHook(
  fastify: FastifyInstance,
  store: IdempotencyStore,
  logger: Logger,
): void {
  fastify.addHook('onSend', async (request, reply, payload) => {
    const claim = requestClaims.get(request);
    if (!claim) return payload;
    requestClaims.delete(request);
    const status = reply.statusCode;
    const storable = (status >= 200 && status < 300) || (status >= 400 && status < 500);
    const text = payloadText(payload);
    const contentType = reply.getHeader('content-type');
    try {
      if (storable && text === '') {
        await store.complete(claim, status, null);
      } else if (storable && text !== undefined && isJsonContentType(contentType)) {
        await store.complete(claim, status, text);
      } else {
        await store.release(claim);
      }
    } catch (err) {
      requestLogger(request, logger).warn({ err, status }, 'idempotency: could not store response');
    }
    return payload;
  });
}

/** DI-friendly wrapper used by `configureApp`. */
@Injectable()
export class IdempotencyHookInstaller {
  constructor(
    private readonly store: IdempotencyStore,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  install(fastify: FastifyInstance): void {
    installIdempotencyHook(fastify, this.store, this.logger);
  }
}
