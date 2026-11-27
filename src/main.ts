import 'reflect-metadata';
// Must stay the first app import: loads .env and validates config before any module is imported.
import { bootConfig } from './config/boot-config';
// Must stay second: starts OpenTelemetry / Sentry (only when configured) before Nest, Fastify,
// pg or ioredis are loaded, so their instrumentations apply.
import './observability/boot-observability';

import { bootstrapHttp, bootstrapWorker, startHttpAndWorkers } from './bootstrap';
import { processMode } from './process-mode';

/**
 * One build, three modes (API-100-45 AC3, D82): the HTTP API (default), the job workers only
 * (`WORKER=1`), or both in one process (`RUN_WORKERS=true`, single-process test hosting).
 */
switch (processMode(bootConfig)) {
  case 'worker':
    void bootstrapWorker();
    break;
  case 'http+workers':
    void startHttpAndWorkers(bootConfig);
    break;
  default:
    void bootstrapHttp(bootConfig);
}
