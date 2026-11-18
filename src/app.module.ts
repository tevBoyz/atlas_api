import { Module } from '@nestjs/common';

import { AuthenticationModule } from './common/auth';
import { ErrorsModule } from './common/errors';
import { IdempotencyModule } from './common/idempotency';
import { ApiConfigModule } from './config';
import { DatabaseModule } from './db';
import { HealthModule } from './health/health.module';
import { FEATURE_MODULES } from './modules';
import { ObservabilityModule } from './observability';
import { OpenApiModule } from './openapi/openapi.module';
import { RedisModule } from './redis';
import { ScaffoldController } from './scaffold.controller';

@Module({
  imports: [
    ApiConfigModule,
    ObservabilityModule,
    ErrorsModule,
    DatabaseModule,
    RedisModule,
    AuthenticationModule,
    IdempotencyModule,
    HealthModule,
    OpenApiModule,
    ...FEATURE_MODULES,
  ],
  controllers: [ScaffoldController],
})
export class AppModule {}
