import { Module } from '@nestjs/common';

import { ErrorsModule } from './common/errors';
import { ApiConfigModule } from './config';
import { DatabaseModule } from './db';
import { HealthModule } from './health/health.module';
import { FEATURE_MODULES } from './modules';
import { ObservabilityModule } from './observability';
import { RedisModule } from './redis';
import { ScaffoldController } from './scaffold.controller';

@Module({
  imports: [
    ApiConfigModule,
    ObservabilityModule,
    ErrorsModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    ...FEATURE_MODULES,
  ],
  controllers: [ScaffoldController],
})
export class AppModule {}
