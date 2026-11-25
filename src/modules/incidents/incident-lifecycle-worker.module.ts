import { Module } from '@nestjs/common';

import { IncidentBroadcaster } from '../../realtime/incident-broadcaster';
import { REALTIME_EMITTER } from '../../realtime/realtime-emitter';
import { RealtimeReadsRepository } from '../../realtime/realtime-reads.repository';
import { WorkerRealtimeEmitter } from '../../realtime/worker-realtime-emitter';
import { AuditModule } from '../audit/audit.module';
import { IncidentCloseSweeper } from './incident-close-sweeper';
import { IncidentEventService } from './incident-events.service';
import { INCIDENT_POST_COMMIT_HOOKS, IncidentPostCommitRunner } from './incident-post-commit';
import { IncidentStateService } from './incident-state.service';

/**
 * The incident lifecycle in the worker process (`WORKER=1`, SCRUM-63, D62): the close sweeper (a
 * job processor of `incident-lifecycle`) with the state service, the event writer, the audit log and
 * the realtime broadcasts it needs. Its broadcasts reach the API's sockets through
 * {@link WorkerRealtimeEmitter} (the Socket.IO Redis adapter). No notification is sent. The
 * broadcaster is also used by the alert delivery status (SCRUM-65 / 71, D73).
 */
@Module({
  imports: [AuditModule],
  providers: [
    WorkerRealtimeEmitter,
    { provide: REALTIME_EMITTER, useExisting: WorkerRealtimeEmitter },
    RealtimeReadsRepository,
    IncidentBroadcaster,
    IncidentEventService,
    IncidentStateService,
    IncidentPostCommitRunner,
    {
      provide: INCIDENT_POST_COMMIT_HOOKS,
      inject: [IncidentBroadcaster],
      useFactory: (broadcaster: IncidentBroadcaster) => [broadcaster],
    },
    IncidentCloseSweeper,
  ],
  exports: [IncidentCloseSweeper, WorkerRealtimeEmitter, IncidentBroadcaster],
})
export class IncidentLifecycleWorkerModule {}
