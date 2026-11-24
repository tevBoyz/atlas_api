import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../common/auth';
import { IncidentBroadcaster } from './incident-broadcaster';
import { MembershipRevocationHook } from './membership-revocation.hook';
import { RealtimeAccessRepository } from './realtime-access.repository';
import { REALTIME_EMITTER } from './realtime-emitter';
import { RealtimeReadsRepository } from './realtime-reads.repository';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Realtime (Phase 4, spec §11.5): the Socket.IO gateway with the Redis adapter (API-100-39), its
 * incident-room authorization and revocation (API-100-40) and the incident broadcasts (API-100-41,
 * API-100-42). The incidents and circles modules import it to register their post-commit hooks;
 * readiness uses the gateway's adapter check.
 */
@Module({
  imports: [AuthenticationModule],
  providers: [
    RealtimeGateway,
    { provide: REALTIME_EMITTER, useExisting: RealtimeGateway },
    RealtimeAccessRepository,
    RealtimeReadsRepository,
    MembershipRevocationHook,
    IncidentBroadcaster,
  ],
  exports: [RealtimeGateway, MembershipRevocationHook, IncidentBroadcaster],
})
export class RealtimeModule {}
