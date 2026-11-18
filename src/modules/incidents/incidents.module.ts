import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { INCIDENT_POST_COMMIT_HOOKS, IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentsController } from './incidents.controller';
import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';

@Module({
  imports: [AuditModule],
  controllers: [IncidentsController],
  providers: [
    IncidentsRepository,
    IncidentsService,
    IncidentPostCommitRunner,
    // API-100-41 (realtime) and API-100-48 (outbox) register their hooks here.
    { provide: INCIDENT_POST_COMMIT_HOOKS, useValue: [] },
  ],
})
export class IncidentsModule {}
