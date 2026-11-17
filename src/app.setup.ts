import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { API_PREFIX, UNPREFIXED_ROUTES } from './app.constants';

/** Shared app setup, used by main.ts and by tests so both see the same routing. */
export function configureApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
}
