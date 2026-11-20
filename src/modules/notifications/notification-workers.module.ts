import { Module } from '@nestjs/common';

import {
  JOB_PROCESSORS,
  type JobProcessor,
  JobWorkers,
  OUTBOX_TOPIC_HANDLERS,
  type OutboxTopicHandler,
  OutboxDispatcher,
} from '../../jobs/job-workers';
import { ChannelSenders } from './channels/channel-senders';
import { DeliveriesRepository } from './deliveries.repository';
import { DeliveryPlanner, DeliverySender } from './deliveries.service';
import { IncidentNotificationsHandler } from './incident-notifications';

/**
 * What the worker process runs (API-100-45 AC3): the outbox consumer with the topic handlers, the
 * channel adapters (API-100-46), the delivery records and retries (API-100-47) and the incident
 * notices (API-100-48).
 */
@Module({
  providers: [
    ChannelSenders,
    DeliveriesRepository,
    DeliveryPlanner,
    DeliverySender,
    IncidentNotificationsHandler,
    {
      provide: OUTBOX_TOPIC_HANDLERS,
      inject: [IncidentNotificationsHandler],
      useFactory: (incidents: IncidentNotificationsHandler): OutboxTopicHandler[] => [incidents],
    },
    OutboxDispatcher,
    {
      provide: JOB_PROCESSORS,
      inject: [OutboxDispatcher, DeliverySender],
      useFactory: (outbox: OutboxDispatcher, deliveries: DeliverySender): JobProcessor[] => [
        outbox,
        deliveries,
      ],
    },
    JobWorkers,
  ],
  exports: [JobWorkers, ChannelSenders, DeliveryPlanner],
})
export class NotificationWorkersModule {}
