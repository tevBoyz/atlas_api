import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { DomainError } from '../errors/domain-error';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { AuthGuard } from './auth.guard';

/**
 * The one global guard. Its order is deliberate and written here rather than left to Nest's module
 * scan order:
 * 1. authentication, so per-user limits know the caller;
 * 2. rate limiting. A request rejected by authentication is counted per IP instead (API-100-11).
 * Guards run before every interceptor, so a refused request never claims an idempotency key.
 */
@Injectable()
export class RequestGuard implements CanActivate {
  constructor(
    private readonly auth: AuthGuard,
    private readonly rateLimit: RateLimitGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    try {
      await this.auth.canActivate(context);
    } catch (error) {
      // Only a real rejection counts: a token that could not be checked (500) is not the caller's.
      if (error instanceof DomainError && error.status === 401) {
        await this.rateLimit.enforceAuthFailure(context);
      }
      throw error;
    }
    await this.rateLimit.enforce(context);
    return true;
  }
}
