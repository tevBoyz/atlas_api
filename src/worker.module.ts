import { Module } from '@nestjs/common';

import { ApiConfigModule } from './config';
import { DatabaseModule } from './db';
import { JobsModule } from './jobs/jobs.module';
import { NotificationWorkersModule } from './modules/notifications/notification-workers.module';
import { ObservabilityModule } from './observability';

/**
 * The worker process (`WORKER=1`, API-100-45 AC3): the same build and image as the API, without the
 * HTTP server. It runs the BullMQ workers and an outbox relay (sweeps only). Configuration, logging
 * and the data stores are the API's.
 */
@Module({
  imports: [
    ApiConfigModule,
    ObservabilityModule,
    DatabaseModule,
    JobsModule,
    NotificationWorkersModule,
  ],
})
export class WorkerModule {}
