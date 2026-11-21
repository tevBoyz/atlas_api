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
  type IncomingInviteJson,
  type InviteChecks,
  type InviteDecisionJson,
  InviteeInvitesRepository,
  type InviteLookupJson,
  type InvitePreviewJson,
  type LockedInviteRow,
  type PreviewParts,
  type RowLockMode,
} from './invitee-invites.repository';
import type { InviteTransaction } from './owner-invites.repository';
import {
  InviteOperationFailedError,
  isTriggerCircleFull,
  sqlStateOf,
} from './owner-invites.service';

type InviteeOperation =
  | 'preview_circle_invite'
  | 'accept_circle_invite'
  | 'decline_circle_invite'
  | 'list_my_circle_invites';

const UNIQUE_VIOLATION = '23505';
/** SQLSTATE of `FOR UPDATE NOWAIT` meeting a row another transaction holds. */
const LOCK_NOT_AVAILABLE = '55P03';
/** How long {@link InviteeInvitesService.lockRowsWithoutWaiting} retries before it waits normally. */
const ROW_LOCK_PATIENCE_MS = 5_000;

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
 * - first, in every invitee write (preview, accept, decline, the incoming-list claim), the caller's
 *   invitee advisory lock (D41, `InviteeInvitesRepository.lockCaller`): one caller's invitee
 *   transactions run one after the other;
 * - accept and preview: read the token's circle, lock the `safety_circles` row, then, in one
 *   `ctid`-ordered statement, the token's member row, the caller's other non-active rows of that
 *   circle and the circle's unclaimed pending rows (`lockInviteForClaim`; D18 order: circle before
 *   member rows, as the owner invite writes, so they cannot deadlock with each other). The SQL
 *   preview locks the member row only; the API's also takes the circle because its claim may
 *   release rows (D41). The multi-row member locks (this one and the incoming-list claim's) never
 *   wait while holding rows (`lockRowsWithoutWaiting`, `FOR UPDATE NOWAIT` with retry);
 * - decline: the member row only (no circle lock, as the SQL).
 * D41 (approved by Dawit 2026-11-21, a deliberate divergence from the SQL functions, which answer
 * 409 `duplicate_membership` here): before the preview claim and the accept write, the caller's
 * FINISHED rows of the circle (declined, canceled, or expired) are released (`user_id = null`, the
 * rest kept as history) in the same transaction, so an old decline or cancel no longer blocks a new
 * invite. A live row is never released: `active` → `already_member`, a still-valid pending row
 * claimed by the caller → `duplicate_membership`, as before. The owner row is never touched.
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
   * row there) else `pending` (claims after releasing the caller's finished rows of the circle,
   * D41; a unique clash with a live row is 409 `duplicate_membership`); else the
   * lookup status with nothing shown. `claimed` follows the SQL's three-valued booleans: it is
   * `null` where the function's expression is null (e.g. the owner previewing an unclaimed invite).
   */
  preview(user: AuthenticatedUser, token: string): Promise<InvitePreviewJson> {
    const operation = 'preview_circle_invite';
    return this.run(operation, async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      await this.repository.lockCaller(tx, user.id);
      const authPhone = await this.repository.authPhone(tx, user.id);
      const raw = pgTrim(token);
      if (raw.length === 0) return this.repository.previewNotFound(tx);
      // D18 / D41: the circle first, then (one ctid-ordered statement) the token's row, the
      // caller's other non-active rows of that circle (the claim may release them) and the
      // circle's unclaimed pending rows.
      const circleId = await this.repository.circleOfToken(tx, raw);
      if (!circleId) return this.repository.previewNotFound(tx);
      if (!(await this.repository.lockCircle(tx, circleId))) {
        return this.repository.previewNotFound(tx);
      }
      const row = await this.lockRowsWithoutWaiting(tx, (sp, mode) =>
        this.repository.lockInviteForClaim(sp, circleId, raw, user.id, mode),
      );
      if (!row) return this.repository.previewNotFound(tx);

      const checks = await this.repository.checks(tx, row.id, user.id, authPhone);
      const parts = await this.previewDecision(tx, user, row, checks);
      return this.repository.previewBody(tx, row.id, parts, this.avatars);
    });
  }

  /**
   * `accept_circle_invite(token)` (final: baseline 20261117120000), in its order: blank → 404
   * `not_found`; the token's circle (unlocked read) → `not_found`; lock the circle row →
   * `not_found`; lock the member row by token (with the caller's other non-active rows of the
   * circle and its unclaimed pending rows, D41) → `not_found` (a token rotated meanwhile); already
   * active for the caller → the same 200 body, no write; lookup status not `pending` → `expired`
   * (410) / `consumed` / `canceled` / `not_found`; not the recipient → 403 `not_recipient`; caller
   * owns the circle → 409 `own_circle`; caller active there via another row → 409 `already_member`;
   * other slot holders + 1 > 5 → 409 `circle_full` (no write); release the caller's finished rows of
   * the circle (D41); then the write (unique clash with a live row → 409 `duplicate_membership`).
   * The audit detail gets `released_finished_rows` when D41 released any.
   */
  accept(user: AuthenticatedUser, token: string): Promise<InviteDecisionJson> {
    const operation = 'accept_circle_invite';
    return this.run(operation, async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      await this.repository.lockCaller(tx, user.id);
      const authPhone = await this.repository.authPhone(tx, user.id);
      const raw = pgTrim(token);
      if (raw.length === 0) throw new DomainError(`${operation}:not_found`);

      const circleId = await this.repository.circleOfToken(tx, raw);
      if (!circleId) throw new DomainError(`${operation}:not_found`);
      if (!(await this.repository.lockCircle(tx, circleId))) {
        throw new DomainError(`${operation}:not_found`);
      }
      const row = await this.lockRowsWithoutWaiting(tx, (sp, mode) =>
        this.repository.lockInviteForClaim(sp, circleId, raw, user.id, mode),
      );
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

      // D41: the caller's finished rows of this circle (declined, canceled, expired) no longer
      // block the write; a live row still does (`duplicate_membership` below).
      const released =
        checks.mine === true
          ? 0
          : await this.repository.releaseFinishedRows(tx, row.circle_id, user.id, row.id);

      let body: InviteDecisionJson | undefined;
      try {
        body = await tx.transaction((sp) => this.repository.acceptWrite(sp, row.id, user.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw new DomainError(`${operation}:duplicate_membership`);
        throw error;
      }
      // `membership.activate` matched no row: unreachable (only member rows can be pending).
      if (!body) throw new Error(`${operation}: membership.activate refused the write`);
      await this.recordAudit(
        tx,
        user,
        'circle.invite.accepted',
        row,
        checks.lookup_status,
        released > 0 ? { released_finished_rows: released } : {},
      );
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
      await this.repository.lockCaller(tx, user.id);
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

  /**
   * `list_my_circle_invites()` (final: baseline 20261019170000), one transaction (read committed, like
   * the RPC):
   * 1. the claim loop: the caller's stored-`pending` rows are locked `FOR UPDATE` (member rows only,
   *    in the function's order, see `lockClaimCandidates`); each row whose lookup status is
   *    `pending`, whose recipient is the caller (`invite.recipient`) and whose circle has no other
   *    active row of the caller (`_circle_has_active_membership`; owners included) is claimed
   *    (`user_id = uid`, still `pending`) when unclaimed, in a savepoint; a `(circle_id, user_id)`
   *    clash is swallowed (the row stays unclaimed), as the function's `exception when
   *    unique_violation then null`. The checks run per row in a new statement after the lock
   *    (`InviteeInvitesRepository.checks`), so a writer that committed meanwhile is seen;
   * 2. the answer ({@link InviteeInvitesRepository.listIncoming}).
   * No audit row: a claim is not a membership change (the preview's claim writes none either).
   * Repeating it is safe (claimed rows are not written again).
   */
  listIncoming(user: AuthenticatedUser): Promise<IncomingInviteJson[]> {
    return this.run('list_my_circle_invites', async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      await this.repository.lockCaller(tx, user.id);
      const authPhone = await this.repository.authPhone(tx, user.id);
      const candidates = await this.lockRowsWithoutWaiting(tx, (sp, mode) =>
        this.repository.lockClaimCandidates(sp, user.id, authPhone, mode),
      );
      for (const memberId of candidates) {
        const checks = await this.repository.checks(tx, memberId, user.id, authPhone);
        if (checks.lookup_status !== 'pending') continue;
        if (!checks.recipient_ok) continue;
        if (checks.other_active) continue;
        // `m.user_id is null` (`mine` is SQL `m.user_id = uid`: null exactly when unclaimed).
        if (checks.mine === null) await this.claimInSavepoint(tx, memberId, user.id);
      }
      return this.repository.listIncoming(tx, user.id, authPhone);
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
        // D41: release the caller's finished rows of this circle first (same transaction, the
        // circle and those rows already locked); a live row still clashes below.
        await this.repository.releaseFinishedRows(tx, row.circle_id, user.id, row.id);
        if (!(await this.claimInSavepoint(tx, row.id, user.id))) {
          throw new DomainError('preview_circle_invite:duplicate_membership');
        }
      }
      return { status: 'pending', showOwner: true, includeRow: true, claimed: true, recipientOk };
    }
    return { status: st, showOwner: false, includeRow: false, claimed: false, recipientOk };
  }

  /**
   * D41: takes a multi-row member lock (`lock`, one statement) without ever waiting for one member
   * row while holding another. Each attempt runs `FOR UPDATE NOWAIT` in a savepoint; a row held by
   * another transaction (55P03) rolls the savepoint back, which releases every row the attempt had
   * locked, and the attempt is repeated after a short, growing, jittered pause (the circle and the
   * caller's advisory lock stay held). So this transaction is never part of a member-row wait cycle
   * with the SQL claim loop (`list_my_circle_invites`: sequential scan, locks as it goes), whose
   * order a concurrent UPDATE can make differ from the `ctid` order. After
   * {@link ROW_LOCK_PATIENCE_MS} of retries (only a transaction holding a member row that long),
   * the last attempt waits normally.
   */
  private async lockRowsWithoutWaiting<T>(
    tx: InviteTransaction,
    lock: (sp: InviteTransaction, mode: RowLockMode) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + ROW_LOCK_PATIENCE_MS;
    let pause = 1;
    for (;;) {
      try {
        return await tx.transaction((sp) => lock(sp, 'nowait'));
      } catch (error) {
        if (sqlStateOf(error) !== LOCK_NOT_AVAILABLE) throw error;
      }
      if (Date.now() >= deadline) return lock(tx, 'wait');
      await new Promise((resolve) => setTimeout(resolve, pause + Math.random() * pause));
      pause = Math.min(pause * 2, 25);
    }
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
