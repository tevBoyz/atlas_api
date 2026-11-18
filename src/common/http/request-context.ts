import { AsyncLocalStorage } from 'node:async_hooks';

import type { FastifyInstance } from 'fastify';

import type { TrustProxy } from '../../config';
import { clientIp } from './client-ip';

/** Facts about the HTTP request being served, for code that has no request object. */
export interface RequestContext {
  requestId: string;
  /** Client address (`clientIp`). */
  ip: string;
}

/** One store per request: concurrent requests never see each other's values. */
const storage = new AsyncLocalStorage<RequestContext>();

/** The context of the current request; undefined outside a request (jobs, startup). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Enters the request context just before the handler. `preHandler` is the first hook after the body
 * has been read: stream events would lose a context entered any earlier. Guards, interceptors, pipes
 * and the handler all run inside it.
 */
export function installRequestContext(fastify: FastifyInstance, trustProxy: TrustProxy): void {
  fastify.addHook('preHandler', (request, _reply, done) => {
    storage.run({ requestId: request.id, ip: clientIp(request, trustProxy) }, done);
  });
}
