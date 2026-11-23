import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { ROOT_LOGGER } from '../../observability/logger';

/** Why a membership ended (API-100-32 AC3). */
export type MembershipEndReason = 'removed' | 'left';

/**
 * A committed end of a membership (`DELETE /v1/circles/{circle_id}/members/{member_id}` or
 * `POST /v1/circles/{circle_id}/leave`). Identifiers only.
 */
export interface MembershipEndedEvent {
  reason: MembershipEndReason;
  circle_id: string;
  /** The member row that ended (kept as `removed` / `left`, D44; a pending or declined row is deleted). */
  member_id: string;
  /** The member's user (null for a pending or declined row nobody claimed). */
  user_id: string | null;
  /** Who ended it: the circle owner (`removed`) or the member themself (`left`). */
  actor_user_id: string;
  /**
   * The stored `ended_at` (UTC JSON text) of an ended ACTIVE membership (D44); null when a pending
   * or declined row was deleted (no membership ended, so no `circle.membership_ended`, D49).
   */
  ended_at: string | null;
}

/**
 * Work that follows a committed membership end: the revocation of live access. API-100-40 makes the
 * user's sockets leave that circle's incident rooms on every instance (`MembershipRevocationHook`),
 * then (D49) `circle.membership_ended` goes to the ended member's user room so their open screens
 * of that circle switch to "no longer available". API-100-42 sends to a user room only while its
 * user passes the window, so nothing else changes there.
 */
export interface MembershipPostCommitHook {
  afterMembershipEnded?(event: MembershipEndedEvent): void | Promise<void>;
}

/** The registered hooks: the realtime revocation (API-100-40). */
export const MEMBERSHIP_POST_COMMIT_HOOKS = Symbol('MEMBERSHIP_POST_COMMIT_HOOKS');

/**
 * Runs the hooks of a membership end that has committed. It is never called for a rolled-back
 * change. The change is already saved at this point, so a hook can neither fail nor delay it: the
 * caller does not wait for the result, and a hook that throws or rejects is logged (ids only) and
 * otherwise ignored.
 */
@Injectable()
export class MembershipPostCommitRunner {
  constructor(
    @Inject(MEMBERSHIP_POST_COMMIT_HOOKS)
    private readonly hooks: readonly MembershipPostCommitHook[],
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** Never rejects. Resolves when every hook has finished. */
  async afterMembershipEnded(event: MembershipEndedEvent): Promise<void> {
    await Promise.all(
      this.hooks.map(async (hook) => {
        try {
          await hook.afterMembershipEnded?.(event);
        } catch (err) {
          this.logger.warn(
            {
              err,
              hook: 'afterMembershipEnded',
              reason: event.reason,
              circle_id: event.circle_id,
              member_id: event.member_id,
            },
            'membership post-commit hook failed',
          );
        }
      }),
    );
  }
}
