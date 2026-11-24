import { Module } from '@nestjs/common';

import {
  JOB_PROCESSORS,
  type JobProcessor,
  JobWorkers,
  OUTBOX_TOPIC_HANDLERS,
  type OutboxTopicHandler,
  OutboxDispatcher,
} from '../../jobs/job-workers';
import { IncidentCloseSweeper } from '../incidents/incident-close-sweeper';
import { IncidentLifecycleWorkerModule } from '../incidents/incident-lifecycle-worker.module';
import { ChannelSenders } from './channels/channel-senders';
import { DeliveriesRepository } from './deliveries.repository';
import { DeliveryPlanner, DeliverySender } from './deliveries.service';
import { IncidentNotificationsHandler } from './incident-notifications';
import { TestAlertNotificationsHandler } from './test-alert-notifications';

/**
 * What the worker process runs (API-100-45 AC3): the outbox consumer with the topic handlers, the
 * channel adapters (API-100-46), the delivery records and retries (API-100-47) and the incident
 * notices (API-100-48) and the test alerts (SCRUM-35, D67). The job workers also run the incident close sweep (SCRUM-63, D62) of
 * `IncidentLifecycleWorkerModule`.
 */
@Module({
  imports: [IncidentLifecycleWorkerModule],
  providers: [
    ChannelSenders,
    DeliveriesRepository,
    DeliveryPlanner,
    DeliverySender,
    IncidentNotificationsHandler,
    TestAlertNotificationsHandler,
    {
      provide: OUTBOX_TOPIC_HANDLERS,
      inject: [IncidentNotificationsHandler, TestAlertNotificationsHandler],
      useFactory: (
        incidents: IncidentNotificationsHandler,
        testAlerts: TestAlertNotificationsHandler,
      ): OutboxTopicHandler[] => [incidents, testAlerts],
    },
    OutboxDispatcher,
    {
      provide: JOB_PROCESSORS,
      inject: [OutboxDispatcher, DeliverySender, IncidentCloseSweeper],
      useFactory: (
        outbox: OutboxDispatcher,
        deliveries: DeliverySender,
        closeSweeper: IncidentCloseSweeper,
      ): JobProcessor[] => [outbox, deliveries, closeSweeper],
    },
    JobWorkers,
  ],
  exports: [JobWorkers, ChannelSenders, DeliveryPlanner],
})
export class NotificationWorkersModule {}
