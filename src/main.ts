import 'reflect-metadata';
// Must stay the first app import: loads .env and validates config before any module is imported.
import { bootConfig } from './config/boot-config';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ApiConfigService, fastifyTrustProxy, nestLogLevels } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: fastifyTrustProxy(bootConfig.TRUST_PROXY) }),
    { logger: nestLogLevels(bootConfig.LOG_LEVEL) },
  );
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen({ port: app.get(ApiConfigService).get('PORT'), host: '0.0.0.0' });
}

void bootstrap();
