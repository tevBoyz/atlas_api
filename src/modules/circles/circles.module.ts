import { Module } from '@nestjs/common';

import { MembershipRevocationHook } from '../../realtime/membership-revocation.hook';
import { RealtimeModule } from '../../realtime/realtime.module';
import { AuditModule } from '../audit/audit.module';
import { CirclesController } from './circles.controller';
import { CirclesRepository } from './circles.repository';
import { CirclesService } from './circles.service';
import { MeCircleController } from './me-circle.controller';
import { MeJoinedCirclesController } from './me-joined-circles.controller';
import { MEMBERSHIP_POST_COMMIT_HOOKS, MembershipPostCommitRunner } from './membership-post-commit';
import { MembershipRepository } from './membership.repository';
import { MembershipService } from './membership.service';

/**
 * Circles (spec §11.3 circles module): the own circle and capacity (API-100-24), the member list
 * (API-100-25), the joined circles (API-100-31), remove and leave through the membership service
 * (API-100-32).
 */
@Module({
  imports: [AuditModule, RealtimeModule],
  controllers: [MeCircleController, MeJoinedCirclesController, CirclesController],
  providers: [
    CirclesRepository,
    CirclesService,
    MembershipRepository,
    MembershipService,
    MembershipPostCommitRunner,
    // Revocation hooks of a committed membership end: the user's sockets leave the circle's incident
    // rooms (API-100-40). User-room events need no revocation: they go only to delivery recipients
    // who still pass the window when the event is sent (API-100-42).
    {
      provide: MEMBERSHIP_POST_COMMIT_HOOKS,
      inject: [MembershipRevocationHook],
      useFactory: (revocation: MembershipRevocationHook) => [revocation],
    },
  ],
  // The invite stories (API-100-26 to 32) reuse the reads and the shared slot rules (invite-slots.ts).
  exports: [CirclesRepository, CirclesService, MembershipService],
})
export class CirclesModule {}
