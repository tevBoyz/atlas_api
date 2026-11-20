import { Module } from '@nestjs/common';

import { AuthenticationModule } from './common/auth';
import { ErrorsModule } from './common/errors';
import { IdempotencyModule } from './common/idempotency';
import { ApiConfigModule } from './config';
import { DatabaseModule } from './db';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { FEATURE_MODULES } from './modules';
import { ObservabilityModule } from './observability';
import { OpenApiModule } from './openapi/openapi.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis';

@Module({
  imports: [
    ApiConfigModule,
    ObservabilityModule,
    ErrorsModule,
    DatabaseModule,
    RedisModule,
    JobsModule,
    AuthenticationModule,
    IdempotencyModule,
    HealthModule,
    OpenApiModule,
    RealtimeModule,
    ...FEATURE_MODULES,
  ],
})
export class AppModule {}
