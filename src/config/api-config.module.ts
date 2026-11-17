import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { ApiConfigService } from './api-config.service';
import { parseConfig } from './config.schema';

/**
 * Validates the environment at startup (API-100-02) and provides {@link ApiConfigService} app-wide.
 * Validation runs when this file is imported (`forRoot` is evaluated by the decorator), so the
 * `.env` file is loaded beforehand by `config/boot-config.ts`, the first import of `main.ts`.
 * This module reads `process.env` only and serves only validated keys.
 * Not to be confused with `modules/config`, which serves the `app_config` business settings.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      ignoreEnvFile: true,
      skipProcessEnv: true,
      cache: true,
      validate: parseConfig,
    }),
  ],
  providers: [ApiConfigService],
  exports: [ApiConfigService],
})
export class ApiConfigModule {}
