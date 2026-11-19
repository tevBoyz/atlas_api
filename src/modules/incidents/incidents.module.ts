import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { INCIDENT_POST_COMMIT_HOOKS, IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentReadsService } from './incident-reads.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';
import { MeIncidentsController } from './me-incidents.controller';

@Module({
  imports: [AuditModule],
  controllers: [IncidentsController, MeIncidentsController],
  providers: [
    IncidentsRepository,
    IncidentsService,
    IncidentReadsService,
    IncidentPostCommitRunner,
    // API-100-41 (realtime) and API-100-48 (outbox) register their hooks here.
    { provide: INCIDENT_POST_COMMIT_HOOKS, useValue: [] },
  ],
})
export class IncidentsModule {}
