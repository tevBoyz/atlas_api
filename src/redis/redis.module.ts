import { Global, Module } from '@nestjs/common';

import { RedisService } from './redis.service';

/** Provides {@link RedisService} (ioredis) app-wide (API-100-07). */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
