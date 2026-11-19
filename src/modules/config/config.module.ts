import { Module } from '@nestjs/common';

import { LiveLocationConfigController } from './live-location-config.controller';
import { LiveLocationConfigService } from './live-location-config.service';

/** Remote client configuration from `app_config` (API-100-17): `GET /v1/config/live-location`. */
@Module({
  controllers: [LiveLocationConfigController],
  providers: [LiveLocationConfigService],
})
export class ConfigModule {}
