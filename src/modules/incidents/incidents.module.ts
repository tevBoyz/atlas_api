import { Module } from '@nestjs/common';

import { IncidentBroadcaster } from '../../realtime/incident-broadcaster';
import { RealtimeModule } from '../../realtime/realtime.module';
import { AuditModule } from '../audit/audit.module';
import { IncidentNotificationsHook } from '../notifications/incident-notifications';
import { NotificationsModule } from '../notifications/notifications.module';
import { IncidentDeliveriesController } from './incident-deliveries.controller';
import { IncidentDeliveriesRepository } from './incident-deliveries.repository';
import { IncidentDeliveriesService } from './incident-deliveries.service';
import { IncidentEventsController } from './incident-events.controller';
import { IncidentEventService } from './incident-events.service';
import { INCIDENT_POST_COMMIT_HOOKS, IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentRespondersController } from './incident-responders.controller';
import { IncidentRespondersRepository } from './incident-responders.repository';
import { IncidentRespondersService } from './incident-responders.service';
import { IncidentReadsService } from './incident-reads.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';
import { MeIncidentsController } from './me-incidents.controller';
import { ResponderIncidentsController } from './responder-incidents.controller';
import { ResponderIncidentsRepository } from './responder-incidents.repository';
import { ResponderIncidentsService } from './responder-incidents.service';

@Module({
  imports: [AuditModule, RealtimeModule, NotificationsModule],
  controllers: [
    IncidentsController,
    MeIncidentsController,
    IncidentDeliveriesController,
    ResponderIncidentsController,
    IncidentEventsController,
    IncidentRespondersController,
  ],
  providers: [
    IncidentEventService,
    IncidentsRepository,
    IncidentsService,
    IncidentReadsService,
    IncidentDeliveriesRepository,
    IncidentDeliveriesService,
    IncidentRespondersRepository,
    IncidentRespondersService,
    ResponderIncidentsRepository,
    ResponderIncidentsService,
    IncidentPostCommitRunner,
    // Realtime broadcasts (API-100-41/42) and the outbox relay kick (API-100-48).
    {
      provide: INCIDENT_POST_COMMIT_HOOKS,
      inject: [IncidentBroadcaster, IncidentNotificationsHook],
      useFactory: (broadcaster: IncidentBroadcaster, notifications: IncidentNotificationsHook) => [
        broadcaster,
        notifications,
      ],
    },
  ],
  // The locations module (attach location) shares the row lock, the JSON shapes and the hooks.
  exports: [IncidentsRepository, IncidentPostCommitRunner],
})
export class IncidentsModule {}
