import { Injectable } from '@nestjs/common';

import type {
  MembershipEndedEvent,
  MembershipPostCommitHook,
} from '../modules/circles/membership-post-commit';
import { SERVER_EVENTS, userRoom } from './realtime.constants';
import { RealtimeGateway } from './realtime.gateway';

/** `circle.membership_ended` (D49): the circle and the database time of the end. Nothing else. */
export function membershipEndedPayload(circleId: string, endedAt: string) {
  return { circle_id: circleId, occurred_at: endedAt };
}

/**
 * API-100-40 AC3: a committed membership end (remove or leave, the only API paths that end an active
 * membership in Phases 1-3; `MembershipService.end`) takes the user's sockets out of every incident
 * room of that circle on every instance at once. A row nobody claimed (no user) has no sockets.
 *
 * Then (gap 19, D49), when an ACTIVE membership ended (`ended_at` set, D44), `circle.membership_ended
 * {circle_id, occurred_at}` goes to `user:{user_id}`: every socket of the removed member, or of the
 * leaver (their other devices too), so open alert / Member View screens of that circle switch to
 * "no longer available". No reason, no names, no member id (SCRUM-30 §4.1: nothing shown beyond the
 * access state). A deleted pending / declined row (no membership) sends nothing.
 */
@Injectable()
export class MembershipRevocationHook implements MembershipPostCommitHook {
  constructor(private readonly gateway: RealtimeGateway) {}

  afterMembershipEnded(event: MembershipEndedEvent): void {
    if (!event.user_id) return;
    this.gateway.revokeMembership(event.user_id, event.circle_id);
    if (event.ended_at === null) return;
    this.gateway.emit(
      [userRoom(event.user_id)],
      SERVER_EVENTS.membershipEnded,
      membershipEndedPayload(event.circle_id, event.ended_at),
    );
  }
}
