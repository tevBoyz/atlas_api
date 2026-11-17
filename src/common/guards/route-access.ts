import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

/**
 * Route-level opt-outs that later global guards MUST honour (API-100-07 AC3):
 * - `@Public()`: no `Authorization` needed. The Supabase JWT guard (API-100-08) skips these routes.
 * - `@SkipRateLimit()`: never rate limited. The rate limiter (API-100-11) skips these routes.
 *
 * Read them with {@link isPublicRoute} / {@link skipsRateLimit} (handler metadata wins over the
 * controller's). Today only health and readiness use both; API-100-08 adds
 * `GET /v1/invites/{token}/status` as public (still rate limited).
 */

export const IS_PUBLIC_KEY = 'atlas:public';
export const SKIP_RATE_LIMIT_KEY = 'atlas:skip-rate-limit';

/** Marks a route (or every route of a controller) as reachable without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Marks a route (or every route of a controller) as exempt from rate limiting. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);

function flag(reflector: Reflector, key: string, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

export function isPublicRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return flag(reflector, IS_PUBLIC_KEY, context);
}

export function skipsRateLimit(reflector: Reflector, context: ExecutionContext): boolean {
  return flag(reflector, SKIP_RATE_LIMIT_KEY, context);
}
