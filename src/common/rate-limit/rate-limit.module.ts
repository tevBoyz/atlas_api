import { Module } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard';
import { RateLimiterService } from './rate-limiter.service';

/** Redis-backed rate limiting (API-100-11). `RequestGuard` applies it to every route. */
@Module({
  providers: [RateLimiterService, RateLimitGuard],
  exports: [RateLimiterService, RateLimitGuard],
})
export class RateLimitModule {}
