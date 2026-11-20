import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import { auditSessionId } from '../incidents/incidents.service';
import {
  type MembershipEndedEvent,
  type MembershipEndReason,
  MembershipPostCommitRunner,
} from './membership-post-commit';
import {
  type LockedMembershipRow,
  MembershipRepository,
  type MembershipTransaction,
} from './membership.repository';

/** The body of `remove_circle_member` (spec §7.2), keys in the function's jsonb order. */
export interface RemovedMemberJson {
  removed: true;
  circle_id: string;
  member_id: string;
}

/** The body of `leave_safety_circle` (spec §7.3), keys in the function's jsonb order. */
export interface LeftCircleJson {
  left: true;
  circle_id: string;
  member_id: string;
}

type MembershipOperation = 'remove_circle_member' | 'leave_safety_circle';

/**
 * A database failure of remove or leave that is not one of its codes (a 500). Carries the
 * operation and SQLSTATE only: never ids of people, names or phones.
 */
export class MembershipOperationFailedError extends Error {
  constructor(
    readonly operation: MembershipOperation,
    readonly sqlState: string | undefined,
  ) {
    super(`${operation} failed in the database`);
    this.name = 'MembershipOperationFailedError';
  }
}

function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * One membership change in progress: its transaction, and the ends to announce once it commits.
 * Only {@link MembershipService.end} adds to `ended`; only a committed change announces them.
 */
export interface MembershipChange {
  readonly tx: MembershipTransaction;
  readonly ended: MembershipEndedEvent[];
}

/**
 * How memberships end (API-100-32): the owner removes a member (`remove_circle_member`, spec §11.3
 * C4) or a member leaves (`leave_safety_circle`, C5). Both go through {@link MembershipService.end},
 * the one place a membership ends, which (a) performs the parity write, (b) writes the audit row
 * `circle.member.removed` / `circle.member.left` in the same transaction, and (c) once the
 * transaction has committed, and never after a rollback, hands the end to the post-commit
 * revocation hooks ({@link MembershipPostCommitRunner}: a no-op until API-100-40/42 force the user's
 * sockets out of the circle's incident rooms; a failing hook never fails the committed change).
 *
 * Parity (spec rule 24): the member row is HARD-DELETED, as the SQL functions do; its
 * `incident_deliveries` go with it (`on delete cascade`). Access ends at once because every incident
 * read requires a current `active` row inside the membership window (rule 54, `incident.memberView`,
 * `incident.eventsView`, `incident.countsView`, `delivery.own`): after the change the user gets 404
 * on that circle's incidents, history included (epic §18.1 P1).
 *
 * Locks: one row, the member row, `FOR UPDATE`, and no `safety_circles` lock, as the functions. The
 * delete then locks that member's delivery rows (cascade). Nothing here locks a profile or an
 * incident, so submit, re-notify, mark safe and acknowledge (profile → incident → deliveries, or the
 * caller's delivery row alone) only ever wait on this transaction or make it wait, never both; the
 * invite writes lock the circle first and then the same member row, and this holds no circle lock.
 *
 * Design note (AC5, not implemented): SCRUM-30 (remove) and SCRUM-31 (leave) replace the hard delete
 * with stored statuses, an app-visible change that belongs to those stories (spec §15.2):
 * - additive status values `removed` and `left` on `safety_circle_members.status` (with
 *   `removed_at`/`removed_by`, `left_at`), written by this method instead of the DELETE; `end` is
 *   the only place to change, its callers and the hooks stay as they are;
 * - the partial unique indexes on `(circle_id, user_id)` and `(circle_id, phone)` limited to
 *   `status in ('pending', 'active')`, so a removed or left person can be invited again (a new row,
 *   a new `activated_at`); `removed`/`left` rows hold no slot (they are not `active`/valid pending);
 * - `incident_deliveries` rows are kept (no cascade fires), so delivery history survives for the
 *   resident; members still lose every incident read, because the policies require `active`;
 * - remove/leave become idempotent (an already removed/left row answers its current state).
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: MembershipRepository,
    private readonly audit: AuditService,
    private readonly postCommit: MembershipPostCommitRunner,
  ) {}

  /**
   * `remove_circle_member(member_id)` (final: baseline 20261019160000), checks in its order: null or
   * unknown id → 404 `not_found` (also a row of another circle than the path's: decision of
   * API-100-32, the function takes no circle); lock the member row; caller does not own the row's
   * circle (`circle.owner`) → 403 `not_authorized`; the owner row → 409 `cannot_remove_owner`; any
   * other row (pending, active, declined) is deleted. 200 `{member_id, circle_id, removed: true}`.
   * No location-sharing or profile check.
   */
  remove(
    user: AuthenticatedUser,
    circleId: string | null,
    memberId: string | null,
  ): Promise<RemovedMemberJson> {
    const operation = 'remove_circle_member';
    return this.change(operation, async (change) => {
      if (memberId === null || circleId === null) throw new DomainError(`${operation}:not_found`);
      const row = await this.repository.lockMemberInCircle(change.tx, memberId, circleId);
      if (!row) throw new DomainError(`${operation}:not_found`);
      if (!(await this.repository.isCircleOwner(change.tx, row.circle_id, user.id))) {
        throw new DomainError(`${operation}:not_authorized`);
      }
      if (row.role === 'owner') throw new DomainError(`${operation}:cannot_remove_owner`);
      await this.end(change, row, 'removed', user);
      return { removed: true, circle_id: row.circle_id, member_id: row.id };
    });
  }

  /**
   * `leave_safety_circle(circle_id)` (final: baseline 20261019160000), checks in its order: null or
   * unknown circle → 404 `not_found`; the caller owns it → 409 `is_owner`; lock the caller's active
   * non-owner row there, none → 403 `not_authorized`; delete it. 200 `{circle_id, member_id, left:
   * true}`.
   */
  leave(user: AuthenticatedUser, circleId: string | null): Promise<LeftCircleJson> {
    const operation = 'leave_safety_circle';
    return this.change(operation, async (change) => {
      if (circleId === null) throw new DomainError(`${operation}:not_found`);
      if (!(await this.repository.circleExists(change.tx, circleId))) {
        throw new DomainError(`${operation}:not_found`);
      }
      if (await this.repository.isCircleOwner(change.tx, circleId, user.id)) {
        throw new DomainError(`${operation}:is_owner`);
      }
      const row = await this.repository.lockActiveMembership(change.tx, circleId, user.id);
      if (!row) throw new DomainError(`${operation}:not_authorized`);
      await this.end(change, row, 'left', user);
      return { left: true, circle_id: row.circle_id, member_id: row.id };
    });
  }

  /**
   * Ends the membership of the locked, non-owner row `row`: the parity write (hard delete, the
   * deliveries cascade), the audit row `circle.member.<reason>` (member row id; circle, the member's
   * `user_id` and the previous stored status; never a name or phone), and the revocation hooks once
   * `change` commits. The caller holds the row lock and has done the operation's checks.
   */
  async end(
    change: MembershipChange,
    row: LockedMembershipRow,
    reason: MembershipEndReason,
    actor: AuthenticatedUser,
  ): Promise<void> {
    // The owner row is never ended (both callers refuse it first); a programming error otherwise.
    if (row.role !== 'member') throw new Error('MembershipService.end: the owner row cannot end');
    if (!(await this.repository.deleteMember(change.tx, row.id))) {
      throw new Error('MembershipService.end: the locked member row was not deleted');
    }
    await this.audit.record(
      {
        action: reason === 'removed' ? 'circle.member.removed' : 'circle.member.left',
        actor_user_id: actor.id,
        actor_session_id: auditSessionId(actor),
        target_type: 'circle_member',
        target_id: row.id,
        detail: {
          circle_id: row.circle_id,
          member_user_id: row.user_id,
          previous_status: row.status,
        },
      },
      change.tx,
    );
    change.ended.push({
      reason,
      circle_id: row.circle_id,
      member_id: row.id,
      user_id: row.user_id,
      actor_user_id: actor.id,
    });
  }

  /**
   * One transaction (read committed, like the RPC). After it COMMITS, the ends it recorded go to the
   * post-commit hooks (not awaited; the runner never rejects). A {@link DomainError} passes through;
   * any other failure is a {@link MembershipOperationFailedError} (no personal data in logs).
   */
  private async change<T>(
    operation: MembershipOperation,
    work: (change: MembershipChange) => Promise<T>,
  ): Promise<T> {
    const ended: MembershipEndedEvent[] = [];
    let result: T;
    try {
      result = await this.database.db.transaction((tx) => work({ tx, ended }));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new MembershipOperationFailedError(operation, sqlStateOf(error));
    }
    for (const event of ended) void this.postCommit.afterMembershipEnded(event);
    return result;
  }
}
