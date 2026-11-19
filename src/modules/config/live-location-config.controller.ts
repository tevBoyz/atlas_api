import { Controller, Get } from '@nestjs/common';

import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { type LiveLocationConfig, liveLocationConfigSchema } from './live-location-config.schemas';
import { LiveLocationConfigService } from './live-location-config.service';

/** Remote configuration for clients (spec §11.3 config module). */
@Controller('config')
export class LiveLocationConfigController {
  constructor(private readonly config: LiveLocationConfigService) {}

  /** `get_live_location_config` (spec rule 35): any valid token, no profile needed. */
  @Get('live-location')
  @Operation('get_live_location_config')
  @ApiContract({
    operationId: 'getLiveLocationConfig',
    summary: 'The live-location upload interval and stale threshold, in seconds',
    tag: 'config',
    responses: {
      200: {
        description: 'Values from app_config; 12 / 45 when a value is missing or not positive',
        name: 'LiveLocationConfig',
        schema: liveLocationConfigSchema,
      },
    },
  })
  liveLocation(): Promise<LiveLocationConfig> {
    return this.config.get();
  }
}
