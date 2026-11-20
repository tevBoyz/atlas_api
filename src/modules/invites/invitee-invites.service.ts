import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError, parityCode } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import { avatarUrlBase, type AvatarUrlBase } from '../circles/circles.repository';
import { CIRCLE_MEMBER_LIMIT, type InviteLookupStatus } from '../circles/invite-slots';
import { auditSessionId } from '../incidents/incidents.service';
import { pgTrim } from './invite-input';
import {
  type InviteChecks,
  type InviteDecisionJson,
  InviteeInvitesRepository,
  type InviteLookupJson,
  type InvitePreviewJson,
  type LockedInviteRow,
  type PreviewParts,
} from './invitee-invites.repository';
import type { InviteTransaction } from './owner-invites.repository';
import {
  InviteOperationFailedError,
  isTriggerCircleFull,
  sqlStateOf,
} from './owner-invites.service';

type InviteeOperation = 'preview_circle_invite' | 'accept_circle_invite' | 'decline_circle_invite';

const UNIQUE_VIOLATION = '23505';

/** A unique-index clash (SQLSTATE 23505) anywhere in the error's cause chain. */
function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}

/** SQL `a AND b` with three-valued logic (`false AND null` = false, `true AND null` = null). */
function sqlAnd(a: boolean, b: boolean | null): boolean | null {
  if (!a) return false;
  return b;
}

/**
 * The invitee's side of an invitation (spec §6.3, §7.3): the public lookup (API-100-29 AC1), the
 * preview with its claim (AC2-5), accept and decline (API-100-30). Each request is one transaction
 * (read committed, like the RPC) with the SQL functions' checks in their order and their locks in
 * their order:
 * - accept: read the token's circle, lock the `safety_circles` row, then the member row (the order
 *   of the owner invite writes, so they cannot deadlock with each other);
 * - preview and decline: the member row only (no circle lock, as the SQL).
 * Every check after a lock runs in a new statement, so a writer that committed while this one
 * waited is seen, as in the plpgsql functions. Accept is the only write in the API that makes a
 * member row `active` (`membership.activate`, spec §4.4 "known bypass"); `activated_at` is left to
 * its trigger. Audit `circle.invite.accepted` / `declined` inside the transaction (ids, channel and
 * previous status only; never a phone, name or token). Accept and decline do not read or need a
 * profile or location sharing (accept reads the accepter's profile name only), and never create a
 * circle. No SMS, email or push.
 */
@Injectable()
export class InviteeInvitesService {
  private readonly avatars: AvatarUrlBase;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: InviteeInvitesRepository,
    private readonly audit: AuditService,
    config: ApiConfigService,
  ) {
    this.avatars = avatarUrlBase(config);
  }

  /**
   * `lookup_circle_invite(token)` (final: baseline 20261019130000): trimmed (spaces); blank or
   * unknown → `not_found` with a null expiry; else the lookup status of spec §5.3 and the row's
   * `invite_expires_at`. Never a name, phone or id. Read-only.
   */
  lookup(token: string): Promise<InviteLookupJson> {
    const raw = pgTrim(token);
    return this.database.db.transaction(
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        if (raw.length === 0) return { status: 'not_found', invite_expires_at: null };
        return this.repository.lookup(tx, raw);
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * `preview_circle_invite(token)` (final: baseline 20261021130000), status logic of spec §7.3,
   * first match wins: unknown/blank → `not_found`; caller owns the circle → `own_circle` (shows the
   * owner, never claims); row active for the caller → `already_member`; lookup `consumed` →
   * `consumed` (nothing shown); `canceled` → row ids only if recipient; `expired` → owner and row
   * only if recipient; caller active in the circle via another row → `already_member`; pending and
   * recipient → `circle_full` when other slot holders + 1 > 5 (claims when the caller has no other
   * row there) else `pending` (claims; a unique clash is 409 `duplicate_membership`); else the
   * lookup status with nothing shown. `claimed` follows the SQL's three-valued booleans: it is
   * `null` where the function's expression is null (e.g. the owner previewing an unclaimed invite).
   */
  preview(user: AuthenticatedUser, token: string): Promise<InvitePreviewJson> {
    const operation = 'preview_circle_invite';
    return this.run(operation, async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      const authPhone = await this.repository.authPhone(tx, user.id);
      const raw = pgTrim(token);
      if (raw.length === 0) return this.repository.previewNotFound(tx);
      const row = await this.repository.lockByToken(tx, raw, user.id);
      if (!row) return this.repository.previewNotFound(tx);

      const checks = await this.repository.checks(tx, row.id, user.id, authPhone);
      const parts = await this.previewDecision(tx, user, row, checks);
      return this.repository.previewBody(tx, row.id, parts, this.avatars);
    });
  }

  /**
   * `accept_circle_invite(token)` (final: baseline 20261117120000), in its order: blank → 404
   * `not_found`; the token's circle (unlocked read) → `not_found`; lock the circle row →
   * `not_found`; lock the member row by token → `not_found` (a token rotated meanwhile); already
   * active for the caller → the same 200 body, no write; lookup status not `pending` → `expired`
   * (410) / `consumed` / `canceled` / `not_found`; not the recipient → 403 `not_recipient`; caller
   * owns the circle → 409 `own_circle`; caller active there via another row → 409 `already_member`;
   * other slot holders + 1 > 5 → 409 `circle_full` (no write); then the write (unique clash → 409
   * `duplicate_membership`).
   */
  accept(user: AuthenticatedUser, token: string): Promise<InviteDecisionJson> {
    const operation = 'accept_circle_invite';
    return this.run(operation, async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      const authPhone = await this.repository.authPhone(tx, user.id);
      const raw = pgTrim(token);
      if (raw.length === 0) throw new DomainError(`${operation}:not_found`);

      const circleId = await this.repository.circleOfToken(tx, raw);
      if (!circleId) throw new DomainError(`${operation}:not_found`);
      if (!(await this.repository.lockCircle(tx, circleId))) {
        throw new DomainError(`${operation}:not_found`);
      }
      const row = await this.repository.lockByToken(tx, raw, user.id);
      if (!row) throw new DomainError(`${operation}:not_found`);

      if (row.active_for_caller) return this.repository.activeBody(tx, row.id);

      const checks = await this.repository.checks(tx, row.id, user.id, authPhone);
      rejectUnlessPending(operation, checks.lookup_status);
      if (!checks.recipient_ok) throw new DomainError(`${operation}:not_recipient`);
      if (checks.caller_owns_circle) throw new DomainError(`${operation}:own_circle`);
      if (checks.other_active) throw new DomainError(`${operation}:already_member`);
      if (checks.used_after > CIRCLE_MEMBER_LIMIT) {
        throw new DomainError(`${operation}:circle_full`);
      }

      let body: InviteDecisionJson | undefined;
      try {
        body = await tx.transaction((sp) => this.repository.acceptWrite(sp, row.id, user.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw new DomainError(`${operation}:duplicate_membership`);
        throw error;
      }
      // `membership.activate` matched no row: unreachable (only member rows can be pending).
      if (!body) throw new Error(`${operation}: membership.activate refused the write`);
      await this.recordAudit(tx, user, 'circle.invite.accepted', row, checks.lookup_status);
      return body;
    });
  }

  /**
   * `decline_circle_invite(token)` (final: baseline 20261021130000), in its order: blank → 404
   * `not_found`; lock the member row by token → `not_found`; lookup status not `pending` →
   * `expired` (410) / `consumed` / `canceled` / `not_found`; not the recipient → 403
   * `not_recipient`. No own-circle or capacity check, no circle lock. Writes `declined` with
   * `user_id = uid`, or without the user when that clashes. Not idempotent: a second decline is
   * `canceled`.
   */
  decline(user: AuthenticatedUser, token: string): Promise<InviteDecisionJson> {
    const operation = 'decline_circle_invite';
    return this.run(operation, async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      const authPhone = await this.repository.authPhone(tx, user.id);
      const raw = pgTrim(token);
      if (raw.length === 0) throw new DomainError(`${operation}:not_found`);
      const row = await this.repository.lockByToken(tx, raw, user.id);
      if (!row) throw new DomainError(`${operation}:not_found`);

      const checks = await this.repository.checks(tx, row.id, user.id, authPhone);
      rejectUnlessPending(operation, checks.lookup_status);
      if (!checks.recipient_ok) throw new DomainError(`${operation}:not_recipient`);

      let body: InviteDecisionJson;
      let claimed = true;
      try {
        body = await tx.transaction((sp) =>
          this.repository.declineWrite(sp, row.id, user.id, true),
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        claimed = false;
        body = await this.repository.declineWrite(tx, row.id, user.id, false);
      }
      await this.recordAudit(tx, user, 'circle.invite.declined', row, checks.lookup_status, {
        user_recorded: claimed,
      });
      return body;
    });
  }

  /** The branches of `preview_circle_invite`, including its claim. */
  private async previewDecision(
    tx: InviteTransaction,
    user: AuthenticatedUser,
    row: LockedInviteRow,
    checks: InviteChecks,
  ): Promise<PreviewParts> {
    const recipientOk = checks.recipient_ok;
    const st = checks.lookup_status;

    if (checks.caller_owns_circle) {
      // Owner preview never claims and never activates.
      return {
        status: 'own_circle',
        showOwner: true,
        includeRow: true,
        claimed: checks.mine,
        recipientOk,
      };
    }
    if (row.active_for_caller) {
      return {
        status: 'already_member',
        showOwner: true,
        includeRow: true,
        claimed: true,
        recipientOk,
      };
    }
    if (st === 'consumed') {
      return {
        status: 'consumed',
        showOwner: false,
        includeRow: false,
        claimed: false,
        recipientOk: false,
      };
    }
    if (st === 'canceled') {
      return {
        status: 'canceled',
        showOwner: false,
        includeRow: recipientOk,
        claimed: sqlAnd(recipientOk, checks.mine),
        recipientOk,
      };
    }
    if (st === 'expired') {
      return {
        status: 'expired',
        showOwner: recipientOk,
        includeRow: recipientOk,
        claimed: sqlAnd(recipientOk, checks.mine),
        recipientOk,
      };
    }
    if (checks.other_active) {
      return {
        status: 'already_member',
        showOwner: true,
        includeRow: true,
        claimed: false,
        recipientOk,
      };
    }
    if (st === 'pending' && recipientOk) {
      if (checks.used_after > CIRCLE_MEMBER_LIMIT) {
        let claimed = false;
        if (checks.mine === true) {
          claimed = true;
        } else if (row.unclaimed && !checks.other_row) {
          claimed = await this.claimInSavepoint(tx, row.id, user.id);
        }
        return { status: 'circle_full', showOwner: true, includeRow: true, claimed, recipientOk };
      }
      if (row.unclaimed) {
        if (!(await this.claimInSavepoint(tx, row.id, user.id))) {
          throw new DomainError('preview_circle_invite:duplicate_membership');
        }
      }
      return { status: 'pending', showOwner: true, includeRow: true, claimed: true, recipientOk };
    }
    return { status: st, showOwner: false, includeRow: false, claimed: false, recipientOk };
  }

  /** The claim in a savepoint: true when written, false on a unique clash (rolled back). */
  private async claimInSavepoint(
    tx: InviteTransaction,
    memberId: string,
    callerId: string,
  ): Promise<boolean> {
    try {
      await tx.transaction((sp) => this.repository.claim(sp, memberId, callerId));
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * One transaction (read committed, like the RPC). A {@link DomainError} passes through; the
   * trigger's raw `circle_full` becomes `<operation>:circle_full` where the operation has that code;
   * anything else is replaced by {@link InviteOperationFailedError} (no token, phone or name in
   * logs).
   */
  private async run<T>(
    operation: InviteeOperation,
    work: (tx: InviteTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.db.transaction((tx) => work(tx));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isTriggerCircleFull(error)) {
        const code = parityCode(operation, 'circle_full');
        if (code) throw new DomainError(code);
      }
      throw new InviteOperationFailedError(operation, sqlStateOf(error));
    }
  }

  /** Audit of an accept or decline: ids, the channel and the previous lookup status only. */
  private recordAudit(
    tx: InviteTransaction,
    user: AuthenticatedUser,
    action: 'circle.invite.accepted' | 'circle.invite.declined',
    row: LockedInviteRow,
    previousStatus: InviteLookupStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor_user_id: user.id,
        actor_session_id: auditSessionId(user),
        target_type: 'circle_member',
        target_id: row.id,
        detail: {
          circle_id: row.circle_id,
          channel: row.phone_invite ? 'phone' : 'link',
          previous_status: previousStatus,
          ...extra,
        },
      },
      tx,
    );
  }
}

/** `_reject_unless_pending(prefix, st)`: the lookup status as the operation's error. */
function rejectUnlessPending(
  operation: 'accept_circle_invite' | 'decline_circle_invite',
  status: InviteLookupStatus,
): void {
  switch (status) {
    case 'pending':
      return;
    case 'expired':
      throw new DomainError(`${operation}:expired`);
    case 'consumed':
      throw new DomainError(`${operation}:consumed`);
    case 'canceled':
      throw new DomainError(`${operation}:canceled`);
    default:
      throw new DomainError(`${operation}:not_found`);
  }
}
