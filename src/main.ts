import 'reflect-metadata';
// Must stay the first app import: loads .env and validates config before any module is imported.
import { bootConfig } from './config/boot-config';
// Must stay second: starts OpenTelemetry / Sentry (only when configured) before Nest, Fastify,
// pg or ioredis are loaded, so their instrumentations apply.
import './observability/boot-observability';

import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp, createFastifyAdapter } from './app.setup';
import { ApiConfigService } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter({ trustProxy: bootConfig.TRUST_PROXY }),
    // Nest's startup logs are held until the JSON logger (LOG_LEVEL) takes over.
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen({ port: app.get(ApiConfigService).get('PORT'), host: '0.0.0.0' });
}

void bootstrap();
