import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp, createFastifyAdapter } from './app.setup';
import { ApiConfigService } from './config';
import type { Config } from './config/config.schema';
import { onShutdownSignal } from './process-mode';
import { WorkerModule } from './worker.module';

/**
 * Process start-up (`main.ts`). Imported only after `config/boot-config` and
 * `observability/boot-observability` (see main.ts), because importing the modules validates the
 * config and loads Nest, Fastify, pg and ioredis.
 */

/** The HTTP API (AppModule on Fastify), configured like every API process, not yet listening. */
export async function createHttpApp(
  config: Pick<Config, 'TRUST_PROXY'>,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter({ trustProxy: config.TRUST_PROXY }),
    // Nest's startup logs are held until the JSON logger (LOG_LEVEL) takes over.
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  configureApp(app);
  return app;
}

async function listen(app: NestFastifyApplication): Promise<void> {
  await app.listen({ port: app.get(ApiConfigService).get('PORT'), host: '0.0.0.0' });
}

/** The job workers (WorkerModule: BullMQ workers, outbox relay, sweepers), not yet started. */
export async function createWorkerContext(): Promise<INestApplicationContext> {
  const worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  worker.useLogger(worker.get(Logger));
  return worker;
}

/** Default mode: the HTTP API, no job workers. */
export async function bootstrapHttp(config: Pick<Config, 'TRUST_PROXY'>): Promise<void> {
  const app = await createHttpApp(config);
  app.enableShutdownHooks();
  await listen(app);
}

/** `WORKER=1` (API-100-45 AC3): the job workers, no HTTP server. Same build, same image. */
export async function bootstrapWorker(): Promise<void> {
  const worker = await createWorkerContext();
  worker.enableShutdownHooks();
  await worker.init();
}

/** The HTTP API and the job workers of one process (D82), and how to stop both. */
export interface HttpAndWorkers {
  http: NestFastifyApplication;
  worker: INestApplicationContext;
  /**
   * Closes the HTTP API first (no new requests, so no new jobs), then the job workers (each BullMQ
   * worker finishes its running jobs). The worker context is closed even if the HTTP close fails.
   * Calling it again returns the same close.
   */
  readonly close: () => Promise<void>;
}

/**
 * Starts the HTTP API AND the job workers in this process (`RUN_WORKERS=true`, D82). Workers start
 * first, so a job the first request enqueues is consumed. `listen: false` (tests) skips the port.
 * With `signals` (main.ts), one SIGTERM / SIGINT handler closes both ({@link onShutdownSignal}).
 */
export async function startHttpAndWorkers(
  config: Pick<Config, 'TRUST_PROXY'>,
  options: { listen?: boolean; signals?: boolean } = {},
): Promise<HttpAndWorkers> {
  const worker = await createWorkerContext();
  await worker.init();
  let http: NestFastifyApplication;
  try {
    http = await createHttpApp(config);
    if (options.listen ?? true) await listen(http);
    else await http.init();
  } catch (error) {
    await worker.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await http.close();
      } finally {
        await worker.close();
      }
    })());
  if (options.signals ?? true) {
    const logger = http.get(Logger);
    onShutdownSignal(close, (error) => logger.error(error, 'shutdown failed'));
  }
  return { http, worker, close };
}
