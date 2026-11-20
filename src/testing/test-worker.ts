import { Test, type TestingModule, type TestingModuleBuilder } from '@nestjs/testing';

import { LOG_DESTINATION } from '../observability/logger';
import { WorkerModule } from '../worker.module';
import { LogCapture } from './test-app';

export interface TestWorker {
  /** The worker process's module (an application context), initialised: the workers run. */
  worker: TestingModule;
  logs: LogCapture;
}

/**
 * The real `WorkerModule` (what `WORKER=1` runs, API-100-45), in-process, with logs captured.
 * `override` can replace providers (topic handlers, channel adapters, config) before it compiles.
 * Close it with `worker.close()`. Test-only (excluded from the build).
 */
export async function createTestWorker(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<TestWorker> {
  const logs = new LogCapture();
  const worker = await override(
    Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(LOG_DESTINATION)
      .useValue(logs),
  ).compile();
  await worker.init();
  return { worker, logs };
}
