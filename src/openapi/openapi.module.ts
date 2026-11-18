import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { OpenApiController, OpenApiService } from './openapi.controller';

/** `GET /v1/openapi.json` (API-100-12). */
@Module({
  imports: [DiscoveryModule],
  controllers: [OpenApiController],
  providers: [OpenApiService],
})
export class OpenApiModule {}
