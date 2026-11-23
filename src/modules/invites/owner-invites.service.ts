import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError, type ErrorPrefix, parityCode } from '../../common/errors';
import { normalizeE164 } from '../../common/policies';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { type AuditAction, AuditService } from '../audit';
import { auditSessionId } from '../incidents/incidents.service';
import {
  INVITE_PHONE_E164,
  INVITE_RELATIONSHIPS,
  LINK_INVITE_DEFAULT_NAME,
  type PhoneInviteArgs,
  pgTrim,
} from './invite-input';
import { newInviteToken } from './invite-token';
import {
  type CanceledInviteJson,
  type InviteTransaction,
  type LockedMemberRow,
  type MemberInvitePayload,
  OwnerInvitesRepository,
} from './owner-invites.repository';

/** The operations behind `_owner_circle_for_invite` (spec rule 11). Cancel is not one of them. */
export type OwnerInviteOperation =
  | 'invite_circle_member_by_phone'
  | 'invite_circle_members_by_phone'
  | 'create_circle_invite_link'
  | 'resend_circle_invite';

/** The response of an invite route whose status depends on the outcome. */
export interface InviteResponse<T> {
  status: 200 | 201;
  body: T;
}

/** `skipped` entry of the batch (keys in the SQL's jsonb order). */
export interface BatchSkipped {
  phone: string;
  reason: 'already_active' | 'already_pending';
  member_id: string;
  display_name: string;
}

/** `not_created` entry of the batch (keys in the SQL's jsonb order). */
export interface BatchNotCreated {
  phone: string | null;
  reason:
    | 'invalid_invite'
    | 'invalid_phone'
    | 'invalid_display_name'
    | 'circle_full'
    | 'duplicate_membership';
  display_name: string | null;
}

/** The body of `invite_circle_members_by_phone` (keys in the SQL's jsonb order). */
export interface BatchInviteResult {
  created: MemberInvitePayload[];
  skipped: BatchSkipped[];
  not_created: BatchNotCreated[];
  available_after: number;
}

/**
 * An owner invite write that failed in the database. Replaces the original error, whose message or
 * detail can carry a phone number or token (e.g. a unique-index violation), so only the operation
 * and the SQLSTATE reach logs and error reports.
 */
export class InviteOperationFailedError extends Error {
  constructor(
    readonly operation: ErrorPrefix,
    readonly sqlState: string | undefined,
  ) {
    super(`${operation} failed in the database`);
    this.name = 'InviteOperationFailedError';
  }
}

/** Why `_refresh_circle_invite` would refuse a row (its checks, in its order). */
type RefreshRefusal =
  'not_invitable' | 'already_active' | 'invalid_display_name' | 'invalid_relationship';

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/** The SQLSTATE of a database error anywhere in its cause chain (Drizzle wraps the pg error). */
export function sqlStateOf(error: unknown): string | undefined {
  for (const item of causes(error)) {
    const code = (item as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The raw `circle_full` of `enforce_safety_circle_member_capacity` (P0001, no prefix). */
export function isTriggerCircleFull(error: unknown): boolean {
  return causes(error).some(
    (item) =>
      item instanceof Error &&
      (item as { code?: unknown }).code === 'P0001' &&
      item.message.trim() === 'circle_full',
  );
}

/** `<operation>:<suffix>` when the catalogue has it, else a plain error (unreachable state → 500). */
function operationError(operation: ErrorPrefix, suffix: string): Error {
  const code = parityCode(operation, suffix);
  return code ? new DomainError(code) : new Error(`${operation}:${suffix}`);
}

/**
 * The owner's invite writes (spec §6.3, §7.2): invite by phone, single (API-100-26 AC2-4) and batch
 * (AC5), the shareable link (API-100-27), resend and cancel (API-100-28). Each request is one
 * transaction with the SQL functions' checks in their order and their row locks in their order:
 * the owner precondition locks the caller's `safety_circles` row first, then member rows are locked
 * (`cancel_circle_invite` locks only the member row, as the SQL). Capacity uses the shared slot rules
 * (`invite-slots.ts`); the database trigger stays the backstop and its raw `circle_full` becomes the
 * operation's code. Audit rows are written inside the transaction (ids and counts only, never a
 * phone, name or token). No SMS is sent (Twilio on hold).
 */
@Injectable()
export class OwnerInvitesService {
  private readonly inviteUrlBase: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OwnerInvitesRepository,
    private readonly audit: AuditService,
    config: ApiConfigService,
  ) {
    this.inviteUrlBase = config.get('INVITE_URL_BASE');
  }

  /**
   * `invite_circle_member_by_phone(display_name, phone, relationship)` (final: baseline
   * 20261117120000). 201 + `resent: false` for a new row; 200 + `resent: true` when the row of that
   * phone was refreshed.
   */
  invitePhone(
    user: AuthenticatedUser,
    args: PhoneInviteArgs,
  ): Promise<InviteResponse<MemberInvitePayload>> {
    const operation = 'invite_circle_member_by_phone';
    return this.run(operation, async (tx) => {
      const circleId = await this.ownerCircleForInvite(tx, user, operation);

      const name = pgTrim(args.displayName ?? '');
      if (name.length === 0) throw new DomainError(`${operation}:invalid_display_name`);
      const phone = pgTrim(args.phone ?? '');
      if (!INVITE_PHONE_E164.test(phone)) throw new DomainError(`${operation}:invalid_phone`);
      const trimmedRelationship = pgTrim(args.relationship ?? '');
      const relationship = trimmedRelationship === '' ? null : trimmedRelationship;
      if (relationship !== null && !INVITE_RELATIONSHIPS.includes(relationship)) {
        throw new DomainError(`${operation}:invalid_relationship`);
      }

      // D44: an ended membership of this phone (removed / left) is history and gives the phone up.
      await this.repository.releaseEndedPhone(tx, circleId, phone);
      const existing = await this.repository.lockMemberByPhone(tx, circleId, phone);
      if (existing) {
        return this.refreshPhoneRow(tx, user, operation, circleId, existing, name, relationship);
      }

      await this.requireSlot(tx, operation, circleId);
      const created = await this.repository.insertPhoneInvite(
        tx,
        { circleId, displayName: name, relationship, phone, token: newInviteToken() },
        this.inviteUrlBase,
      );
      if (!created) {
        // Unique clash (a writer that does not lock the circle row): the SQL re-reads the phone's
        // row and treats it as an existing row.
        const clashed = await this.repository.lockMemberByPhone(tx, circleId, phone);
        if (!clashed) throw new DomainError(`${operation}:duplicate_membership`);
        return this.refreshPhoneRow(tx, user, operation, circleId, clashed, name, relationship);
      }
      await this.recordAudit(tx, user, 'circle.invite.created', created, { channel: 'phone' });
      return { status: 201, body: created };
    });
  }

  /**
   * `invite_circle_members_by_phone(p_invites)` (final: baseline 20261117120000): one transaction,
   * items in array order, one outcome per item. `invites` is the request's JSON value as sent.
   */
  inviteBatch(user: AuthenticatedUser, invites: unknown): Promise<BatchInviteResult> {
    const operation = 'invite_circle_members_by_phone';
    return this.run(operation, async (tx) => {
      const circleId = await this.ownerCircleForInvite(tx, user, operation);
      if (!Array.isArray(invites)) throw new DomainError(`${operation}:invalid_invites`);

      const result: BatchInviteResult = {
        created: [],
        skipped: [],
        not_created: [],
        available_after: 0,
      };
      const notCreated = (
        phone: string | null,
        reason: BatchNotCreated['reason'],
        displayName: string | null,
      ) => result.not_created.push({ phone, reason, display_name: displayName });
      const skipped = (
        phone: string,
        reason: BatchSkipped['reason'],
        memberId: string,
        displayName: string,
      ) => result.skipped.push({ phone, reason, member_id: memberId, display_name: displayName });

      let available = await this.repository.availableSlots(tx, circleId);
      for (const item of await this.repository.batchItems(tx, invites)) {
        if (!item.is_object) {
          notCreated(null, 'invalid_invite', null);
          continue;
        }

        const name = pgTrim(item.display_name ?? '');
        const phone = normalizeE164(item.phone);
        const shownPhone = phone ?? (pgTrim(item.phone ?? '') || null);
        if (phone === null || !INVITE_PHONE_E164.test(phone)) {
          notCreated(shownPhone, 'invalid_phone', name === '' ? null : name);
          continue;
        }
        if (name.length === 0) {
          notCreated(phone, 'invalid_display_name', null);
          continue;
        }

        // D44: an ended membership of this phone (removed / left) gives the phone up.
        await this.repository.releaseEndedPhone(tx, circleId, phone);
        const existing = await this.repository.lockMemberByPhone(tx, circleId, phone);
        if (existing && (existing.status === 'active' || existing.consumed)) {
          skipped(phone, 'already_active', existing.id, name);
          continue;
        }
        // Valid pending only. An expired pending row is refreshed below and needs a free slot,
        // like a declined row.
        if (existing?.holds_slot) {
          skipped(phone, 'already_pending', existing.id, name);
          continue;
        }
        if (available <= 0) {
          notCreated(phone, 'circle_full', name);
          continue;
        }

        if (existing) {
          const refusal = refreshRefusal(existing, name, undefined);
          if (refusal === 'already_active') {
            skipped(phone, 'already_active', existing.id, name);
            continue;
          }
          if (refusal) throw new Error(`${operation}:${refusal}`);
          const refreshed = await this.inSavepoint(tx, (sp) =>
            this.repository.refresh(
              sp,
              {
                memberId: existing.id,
                displayName: name,
                relationship: existing.relationship,
                token: newInviteToken(),
              },
              this.inviteUrlBase,
            ),
          );
          if (refreshed === 'circle_full') {
            notCreated(phone, 'circle_full', name);
            continue;
          }
          result.created.push(refreshed);
          available -= 1;
          await this.recordAudit(tx, user, 'circle.invite.resent', refreshed, {
            channel: 'phone_batch',
            previous_status: existing.lookup_status,
          });
          continue;
        }

        const inserted = await this.inSavepoint(tx, (sp) =>
          this.repository.insertPhoneInvite(
            sp,
            { circleId, displayName: name, relationship: null, phone, token: newInviteToken() },
            this.inviteUrlBase,
          ),
        );
        if (inserted === 'circle_full') {
          notCreated(phone, 'circle_full', name);
          continue;
        }
        if (inserted === undefined) {
          const clashed = await this.repository.lockMemberByPhone(tx, circleId, phone);
          if (!clashed) notCreated(phone, 'duplicate_membership', name);
          else if (clashed.status === 'active' || clashed.consumed) {
            skipped(phone, 'already_active', clashed.id, name);
          } else if (clashed.status === 'pending') {
            skipped(phone, 'already_pending', clashed.id, name);
          } else notCreated(phone, 'duplicate_membership', name);
          continue;
        }
        result.created.push(inserted);
        available -= 1;
        await this.recordAudit(tx, user, 'circle.invite.created', inserted, {
          channel: 'phone_batch',
        });
      }

      result.available_after = await this.repository.availableSlots(tx, circleId);
      return result;
    });
  }

  /**
   * `create_circle_invite_link(display_name)` (final: baseline 20261021120000): blank or missing
   * name → `Invited member`; needs a free slot; inserts a pending row without a phone.
   */
  createLink(user: AuthenticatedUser, displayName: string | null): Promise<MemberInvitePayload> {
    const operation = 'create_circle_invite_link';
    return this.run(operation, async (tx) => {
      const circleId = await this.ownerCircleForInvite(tx, user, operation);
      const name = pgTrim(displayName ?? '') || LINK_INVITE_DEFAULT_NAME;
      await this.requireSlot(tx, operation, circleId);
      const created = await this.repository.insertLinkInvite(
        tx,
        circleId,
        name,
        newInviteToken(),
        this.inviteUrlBase,
      );
      await this.recordAudit(tx, user, 'circle.invite.created', created, { channel: 'link' });
      return created;
    });
  }

  /**
   * `resend_circle_invite(member_id)` (final: baseline 20261117120000): same row, new token (the old
   * one then looks up as `not_found`), new 7-day expiry. A declined or expired row takes a slot
   * (`circle_full`, nothing written); a valid pending row does not. `memberId` null is the SQL
   * argument null (`member_not_found`).
   */
  resend(user: AuthenticatedUser, memberId: string | null): Promise<MemberInvitePayload> {
    const operation = 'resend_circle_invite';
    return this.run(operation, async (tx) => {
      const circleId = await this.ownerCircleForInvite(tx, user, operation);
      if (memberId === null) throw new DomainError(`${operation}:member_not_found`);
      const existing = await this.repository.lockMemberInCircle(tx, memberId, circleId);
      if (!existing) throw new DomainError(`${operation}:member_not_found`);

      if (
        existing.role === 'member' &&
        existing.status !== 'active' &&
        !existing.consumed &&
        !existing.holds_slot
      ) {
        await this.requireSlot(tx, operation, circleId);
      }

      const refusal = refreshRefusal(existing, null, undefined);
      if (refusal) throw operationError(operation, refusal);
      const body = await this.repository.refresh(
        tx,
        {
          memberId: existing.id,
          displayName: existing.display_name,
          relationship: existing.relationship,
          token: newInviteToken(),
        },
        this.inviteUrlBase,
      );
      await this.recordAudit(tx, user, 'circle.invite.resent', body, {
        channel: 'resend',
        previous_status: existing.lookup_status,
      });
      return body;
    });
  }

  /**
   * `cancel_circle_invite(member_id)` (final: baseline 20261117120000), checks in its order: unknown
   * (or null) id → `not_found`; caller does not own the row's circle → `not_authorized`; owner row →
   * `cannot_cancel_owner`; lookup status not `pending`/`expired` → `not_pending`. Writes `declined` +
   * `invite_canceled_at`. No profile or location-sharing check; locks the member row only. Never
   * returns `cancel_circle_invite:expired`.
   */
  cancel(user: AuthenticatedUser, memberId: string | null): Promise<CanceledInviteJson> {
    const operation = 'cancel_circle_invite';
    return this.run(operation, async (tx) => {
      if (memberId === null) throw new DomainError(`${operation}:not_found`);
      const row = await this.repository.lockMember(tx, memberId);
      if (!row) throw new DomainError(`${operation}:not_found`);
      if (!(await this.repository.isCircleOwner(tx, row.circle_id, user.id))) {
        throw new DomainError(`${operation}:not_authorized`);
      }
      if (row.role === 'owner') throw new DomainError(`${operation}:cannot_cancel_owner`);
      if (row.lookup_status !== 'pending' && row.lookup_status !== 'expired') {
        throw new DomainError(`${operation}:not_pending`);
      }
      const body = await this.repository.cancel(tx, row.id);
      await this.audit.record(
        {
          action: 'circle.invite.canceled',
          actor_user_id: user.id,
          actor_session_id: auditSessionId(user),
          target_type: 'circle_member',
          target_id: row.id,
          detail: { circle_id: row.circle_id, previous_status: row.lookup_status },
        },
        tx,
      );
      return body;
    });
  }

  /**
   * `_owner_circle_for_invite(prefix)` (baseline 20261019120000), spec rule 11, in its order: the
   * caller's profile (`profile_not_found`), `location_sharing_enabled` (`location_sharing_disabled`),
   * the owned circle locked `FOR UPDATE` (`circle_not_found`). Returns the circle id.
   */
  private async ownerCircleForInvite(
    tx: InviteTransaction,
    user: AuthenticatedUser,
    operation: OwnerInviteOperation,
  ): Promise<string> {
    await this.repository.useUtcTimestamps(tx);
    const profile = await this.repository.ownerSharing(tx, user.id);
    if (!profile) throw new DomainError(`${operation}:profile_not_found`);
    // `if not sharing`: null (impossible, the column is not null) would not raise, as in plpgsql.
    if (profile.sharing === false) throw new DomainError(`${operation}:location_sharing_disabled`);
    const circleId = await this.repository.lockOwnedCircle(tx, user.id);
    if (!circleId) throw new DomainError(`${operation}:circle_not_found`);
    return circleId;
  }

  /** `_require_circle_invite_slot`: the circle row is already locked; refuse when nothing is free. */
  private async requireSlot(
    tx: InviteTransaction,
    operation:
      'invite_circle_member_by_phone' | 'create_circle_invite_link' | 'resend_circle_invite',
    circleId: string,
  ): Promise<void> {
    if ((await this.repository.availableSlots(tx, circleId)) <= 0) {
      throw new DomainError(`${operation}:circle_full`);
    }
  }

  /** AC3 of API-100-26: refresh the phone's existing row (200, `resent: true`). */
  private async refreshPhoneRow(
    tx: InviteTransaction,
    user: AuthenticatedUser,
    operation: 'invite_circle_member_by_phone',
    circleId: string,
    existing: LockedMemberRow,
    name: string,
    relationship: string | null,
  ): Promise<InviteResponse<MemberInvitePayload>> {
    if (existing.status === 'active' || existing.consumed) {
      throw new DomainError(`${operation}:already_active`);
    }
    // A valid pending invite already holds a slot; an expired or declined row does not.
    if (!existing.holds_slot) await this.requireSlot(tx, operation, circleId);

    const keptRelationship = relationship ?? existing.relationship;
    const refusal = refreshRefusal(existing, name, keptRelationship ?? undefined);
    if (refusal) throw operationError(operation, refusal);
    const body = await this.repository.refresh(
      tx,
      {
        memberId: existing.id,
        displayName: name,
        relationship: keptRelationship,
        token: newInviteToken(),
      },
      this.inviteUrlBase,
    );
    await this.recordAudit(tx, user, 'circle.invite.resent', body, {
      channel: 'phone',
      previous_status: existing.lookup_status,
    });
    return { status: 200, body };
  }

  /**
   * Runs `work` in a savepoint (the SQL's `begin ... exception` block): the trigger's raw
   * `circle_full` rolls back to the savepoint and is returned as `'circle_full'`; anything else
   * propagates.
   */
  private async inSavepoint<T>(
    tx: InviteTransaction,
    work: (sp: InviteTransaction) => Promise<T>,
  ): Promise<T | 'circle_full'> {
    try {
      return await tx.transaction((sp) => work(sp));
    } catch (error) {
      if (isTriggerCircleFull(error)) return 'circle_full';
      throw error;
    }
  }

  /**
   * One transaction (read committed, like the RPC). A {@link DomainError} passes through; the
   * trigger's raw `circle_full` becomes `<operation>:circle_full` (API-100-05 AC3); anything else is
   * replaced by {@link InviteOperationFailedError} (no phone, name or token in logs).
   */
  private async run<T>(
    operation: ErrorPrefix,
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

  /** Audit of a created or refreshed invite: ids and the outcome only (API-100-14 AC4). */
  private recordAudit(
    tx: InviteTransaction,
    user: AuthenticatedUser,
    action: AuditAction,
    payload: MemberInvitePayload,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor_user_id: user.id,
        actor_session_id: auditSessionId(user),
        target_type: 'circle_member',
        target_id: payload.member_id,
        detail: { circle_id: payload.circle_id, ...detail },
      },
      tx,
    );
  }
}

/**
 * The checks of `_refresh_circle_invite(p_member_id, err_prefix, p_display_name, p_relationship)`
 * (baseline 20261019160000) on the locked row, in its order. `displayName` null keeps the stored
 * name; `relationship` undefined (SQL null) keeps the stored one.
 */
function refreshRefusal(
  row: LockedMemberRow,
  displayName: string | null,
  relationship: string | undefined,
): RefreshRefusal | undefined {
  if (row.role !== 'member') return 'not_invitable';
  if (row.status === 'active' || row.consumed) return 'already_active';
  const name = (displayName === null ? '' : pgTrim(displayName)) || row.display_name;
  if (name.length === 0) return 'invalid_display_name';
  const kept = relationship === undefined ? row.relationship : pgTrim(relationship) || null;
  if (kept !== null && !INVITE_RELATIONSHIPS.includes(kept)) return 'invalid_relationship';
  return undefined;
}
