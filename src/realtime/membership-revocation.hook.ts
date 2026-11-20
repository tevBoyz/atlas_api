import { Injectable } from '@nestjs/common';

import type {
  MembershipEndedEvent,
  MembershipPostCommitHook,
} from '../modules/circles/membership-post-commit';
import { RealtimeGateway } from './realtime.gateway';

/**
 * API-100-40 AC3: a committed membership end (remove or leave, the only API paths that end an active
 * membership in Phases 1-3; `MembershipService.end`) takes the user's sockets out of every incident
 * room of that circle on every instance at once. A row nobody claimed (no user) has no sockets.
 */
@Injectable()
export class MembershipRevocationHook implements MembershipPostCommitHook {
  constructor(private readonly gateway: RealtimeGateway) {}

  afterMembershipEnded(event: MembershipEndedEvent): void {
    if (event.user_id) this.gateway.revokeMembership(event.user_id, event.circle_id);
  }
}
