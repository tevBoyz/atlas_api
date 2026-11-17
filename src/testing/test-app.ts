import { Writable } from 'node:stream';

import type { ModuleMetadata } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { AppModule } from '../app.module';
import { configureApp, createFastifyAdapter } from '../app.setup';
import { LOG_DESTINATION } from '../observability/logger';

/** Collects the JSON log lines an app writes, for assertions. Test-only (excluded from the build). */
export class LogCapture extends Writable {
  readonly raw: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.raw.push(chunk.toString());
    callback();
  }

  /** Every line written so far, as one string. */
  get text(): string {
    return this.raw.join('');
  }

  /** Parsed log lines. */
  get lines(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  logs: LogCapture;
}

/**
 * The real AppModule (plus optional extra controllers/providers) on the same Fastify adapter and
 * setup as main.ts, with logs captured instead of written to stdout. `override` can replace
 * providers (e.g. fake data stores) before the module compiles.
 */
export async function createTestApp(
  extra: ModuleMetadata = {},
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<TestApp> {
  const logs = new LogCapture();
  const moduleRef = await override(
    Test.createTestingModule({ imports: [AppModule], ...extra })
      .overrideProvider(LOG_DESTINATION)
      .useValue(logs),
  ).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
    logger: false,
  });
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, logs };
}
