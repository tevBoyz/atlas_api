import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { IncidentDeliveriesController } from './incident-deliveries.controller';
import { IncidentDeliveriesRepository } from './incident-deliveries.repository';
import { IncidentDeliveriesService } from './incident-deliveries.service';
import { IncidentEventsController } from './incident-events.controller';
import { IncidentEventService } from './incident-events.service';
import { INCIDENT_POST_COMMIT_HOOKS, IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentReadsService } from './incident-reads.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';
import { MeIncidentsController } from './me-incidents.controller';
import { ResponderIncidentsController } from './responder-incidents.controller';
import { ResponderIncidentsRepository } from './responder-incidents.repository';
import { ResponderIncidentsService } from './responder-incidents.service';

@Module({
  imports: [AuditModule],
  controllers: [
    IncidentsController,
    MeIncidentsController,
    IncidentDeliveriesController,
    ResponderIncidentsController,
    IncidentEventsController,
  ],
  providers: [
    IncidentEventService,
    IncidentsRepository,
    IncidentsService,
    IncidentReadsService,
    IncidentDeliveriesRepository,
    IncidentDeliveriesService,
    ResponderIncidentsRepository,
    ResponderIncidentsService,
    IncidentPostCommitRunner,
    // API-100-41 (realtime) and API-100-48 (outbox) register their hooks here.
    { provide: INCIDENT_POST_COMMIT_HOOKS, useValue: [] },
  ],
  // The locations module (attach location) shares the row lock, the JSON shapes and the hooks.
  exports: [IncidentsRepository, IncidentPostCommitRunner],
})
export class IncidentsModule {}
