import { SetMetadata } from '@nestjs/common';

import type { RateLimitRule } from './rate-limit.policies';

export type { RateLimitRule } from './rate-limit.policies';

export const RATE_LIMIT_METADATA = 'atlas:rate-limit';

/**
 * The limit of one route (API-100-11), replacing the default for its kind of route: per user on
 * authenticated routes, per IP on `@Public()` routes.
 *
 * ```ts
 * @RateLimit('emergency_write')    // SOS submit, mark safe: 30 / min per user
 * @RateLimit('location_ping')      // 30 / min per user per incident (path parameter `id`)
 * @RateLimit({ name: 'login_status', max: 60, windowSeconds: 300, scope: 'ip',
 *              code: 'login_lockout:rate_limited' })
 * ```
 *
 * A `user_incident` route also counts towards the caller's `authenticated` limit, so inventing
 * incident ids cannot bypass it. Other routes count only against their own policy: a burst of
 * ordinary requests can never use up the budget of an SOS.
 */
export const RateLimit = (rule: RateLimitRule): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, rule);
