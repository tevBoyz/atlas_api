import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';
import { EXPECTED_MIGRATIONS, loadExpectedMigrations } from './expected-migrations';
import { HealthController } from './health.controller';
import { READINESS_CHECK_TIMEOUT_MS } from './readiness';
import { READINESS_TIMEOUT_MS, ReadinessService } from './readiness.service';

/** `GET /healthz` and `GET /readyz` (API-100-07). Uses the global DatabaseModule and RedisModule. */
@Module({
  imports: [RealtimeModule],
  controllers: [HealthController],
  providers: [
    ReadinessService,
    { provide: EXPECTED_MIGRATIONS, useFactory: () => loadExpectedMigrations() },
    { provide: READINESS_TIMEOUT_MS, useValue: READINESS_CHECK_TIMEOUT_MS },
  ],
})
export class HealthModule {}
