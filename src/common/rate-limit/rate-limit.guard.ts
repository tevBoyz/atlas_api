import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { ApiConfigService } from '../../config';
import { getRequestUser } from '../auth/authenticated-user';
import { DomainError } from '../errors/domain-error';
import { isPublicRoute, skipsRateLimit } from '../guards/route-access';
import { clientIp } from '../http/client-ip';
import { RATE_LIMIT_METADATA, type RateLimitRule } from './rate-limit.decorator';
import { namedPolicy, type RateLimitPolicy } from './rate-limit.policies';
import { RATE_LIMIT_KEY_PREFIX, RateLimiterService } from './rate-limiter.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies the limits of a route (API-100-11). Called by `RequestGuard` after authentication, so a
 * per-user limit knows the user, and before the interceptors, so a 429 never reaches the idempotency
 * layer and is never stored as an idempotent response.
 */
@Injectable()
export class RateLimitGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ApiConfigService,
    private readonly limiter: RateLimiterService,
  ) {}

  /** Counts the request against the route's policy. Throws the 429 when it is over the limit. */
  async enforce(context: ExecutionContext): Promise<void> {
    if (skipsRateLimit(this.reflector, context)) return;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    for (const policy of this.policiesOf(context)) {
      await this.consume(policy, request);
    }
  }

  /**
   * Counts a request rejected by authentication against its IP, so bad tokens cannot be sprayed
   * without limit. Only rejected requests count: a valid token is never refused by this limit, even
   * from an address that is over it (many phones can share one carrier address).
   */
  async enforceAuthFailure(context: ExecutionContext): Promise<void> {
    if (skipsRateLimit(this.reflector, context)) return;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    await this.consume(namedPolicy('auth_failure', this.config), request);
  }

  private policiesOf(context: ExecutionContext): RateLimitPolicy[] {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rule === undefined) {
      const name = isPublicRoute(this.reflector, context) ? 'public' : 'authenticated';
      return [namedPolicy(name, this.config)];
    }
    const policy = typeof rule === 'string' ? namedPolicy(rule, this.config) : rule;
    return policy.scope === 'user_incident'
      ? [policy, namedPolicy('authenticated', this.config)]
      : [policy];
  }

  private async consume(policy: RateLimitPolicy, request: FastifyRequest): Promise<void> {
    const key = `${RATE_LIMIT_KEY_PREFIX}:${policy.name}:${this.subject(policy, request)}`;
    const decision = await this.limiter.consume(key, policy.max, policy.windowSeconds);
    if (decision.allowed) return;
    throw new DomainError(policy.code ?? 'rate_limit:exceeded', {
      retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
    });
  }

  private subject(policy: RateLimitPolicy, request: FastifyRequest): string {
    const user = getRequestUser(request);
    // Without a caller a user-keyed policy cannot apply (the route contract forbids it): use the IP.
    if (policy.scope === 'ip' || !user) {
      return `ip:${clientIp(request, this.config.get('TRUST_PROXY'))}`;
    }
    if (policy.scope === 'user') return `u:${user.id}`;
    const params = request.params as Record<string, string | undefined> | undefined;
    const incidentId = params?.[policy.incidentParam ?? 'id'];
    // Anything that is not a UUID shares one counter: it cannot mint unlimited keys.
    const incident = incidentId && UUID.test(incidentId) ? incidentId.toLowerCase() : 'invalid';
    return `u:${user.id}:i:${incident}`;
  }
}
