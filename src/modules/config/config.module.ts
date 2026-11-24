import { Module } from '@nestjs/common';

import { EmergencyNumbersController } from './emergency-numbers.controller';
import { LiveLocationConfigController } from './live-location-config.controller';
import { LiveLocationConfigService } from './live-location-config.service';

/**
 * Remote client configuration from `app_config` (API-100-17): `GET /v1/config/live-location`, and
 * `GET /v1/config/emergency-numbers` (SCRUM-54, D60).
 */
@Module({
  controllers: [LiveLocationConfigController, EmergencyNumbersController],
  providers: [LiveLocationConfigService],
})
export class ConfigModule {}
