import { Global, Module } from '@nestjs/common';

import { JobQueues } from './job-queues.service';
import { OutboxWriter } from './outbox';
import { OutboxRelay } from './outbox-relay.service';

/**
 * Jobs (API-100-45, spec §11.6): the BullMQ producers, the outbox writer and the outbox relay, in
 * every process (the HTTP API and the `WORKER=1` process). The workers themselves are only started
 * by the worker process (`src/worker.module.ts`).
 */
@Global()
@Module({
  providers: [JobQueues, OutboxWriter, OutboxRelay],
  exports: [JobQueues, OutboxWriter, OutboxRelay],
})
export class JobsModule {}
