import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { circleOwner } from '../../common/policies';
import type { Database } from '../../db/database.service';
import {
  capacityJsonSql,
  holdsSlotSql,
  inviteLookupStatusSql,
  type InviteLookupStatus,
  memberAlias,
} from '../circles/invite-slots';

/** The open transaction of an owner invite write (SQL, savepoints and the audit row). */
export type InviteTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that runs SQL: the transaction or one of its savepoints. */
export type InviteExecutor = Pick<Database, 'execute'>;

/** MemberInvitePayload (spec §7.0, `_circle_invite_payload`), as Postgres builds it. */
export type MemberInvitePayload = Record<string, unknown> & {
  member_id: string;
  circle_id: string;
  status: string;
  display_name: string;
  relationship: string | null;
  phone: string | null;
  invite_token: string;
  invite_url: string;
  invited_at: string;
  invite_expires_at: string | null;
  resent: boolean;
};

/** The body of `cancel_circle_invite` (spec §7.2). */
export type CanceledInviteJson = Record<string, unknown> & {
  member_id: string;
  circle_id: string;
  status: 'canceled';
  owner_name: string | null;
};

/**
 * A `safety_circle_members` row locked `FOR UPDATE`, with the shared slot rules evaluated by
 * Postgres at the transaction's `now()` (`holdsSlot` / `inviteLookupStatus`, API-100-24 AC3).
 */
export interface LockedMemberRow extends Record<string, unknown> {
  id: string;
  circle_id: string;
  role: string;
  status: string;
  display_name: string;
  relationship: string | null;
  /** `invite_consumed_at is not null`. */
  consumed: boolean;
  /** `_circle_invite_holds_slot(m)`. */
  holds_slot: boolean;
  /** `_circle_invite_lookup_status(m)`. */
  lookup_status: InviteLookupStatus;
}

/** One element of the batch, as `jsonb_array_elements` + `->>` read it. */
export interface BatchItemRow extends Record<string, unknown> {
  is_object: boolean;
  display_name: string | null;
  phone: string | null;
}

export interface PhoneInsert {
  circleId: string;
  displayName: string;
  relationship: string | null;
  phone: string;
  token: string;
}

export interface InviteRefresh {
  memberId: string;
  displayName: string;
  relationship: string | null;
  token: string;
}

const LOCKED_MEMBER_COLUMNS = (() => {
  const m = memberAlias('m');
  return sql`m.id::text as id,
             m.circle_id::text as circle_id,
             m.role,
             m.status,
             m.display_name,
             m.relationship,
             (m.invite_consumed_at is not null) as consumed,
             ${holdsSlotSql(m)} as holds_slot,
             ${inviteLookupStatusSql(m)} as lookup_status`;
})();

/**
 * The SQL of the owner invite writes (API-100-26/27/28): the owner precondition, the row locks, the
 * capacity read, and the writes of `_refresh_circle_invite`, the invite inserts and
 * `cancel_circle_invite`. Lock order is the SQL functions': the caller's `safety_circles` row first
 * (`_owner_circle_for_invite`), then member rows. Never writes `activated_at` (its trigger owns it)
 * and never sets `status = 'active'` (spec §4.4 "known bypass", `membership.activate`).
 */
@Injectable()
export class OwnerInvitesRepository {
  /** Timestamps in JSON as UTC text (`...+00:00`), as the hosted project's sessions write them. */
  async useUtcTimestamps(tx: InviteExecutor): Promise<void> {
    await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
  }

  /** `profiles.location_sharing_enabled` of the caller; undefined when there is no profile row. */
  async ownerSharing(
    tx: InviteExecutor,
    callerId: string,
  ): Promise<{ sharing: boolean | null } | undefined> {
    const result = await tx.execute<{ sharing: boolean | null }>(sql`
      select p.location_sharing_enabled as sharing
        from public.profiles p
       where p.id = ${callerId}::uuid`);
    return result.rows[0];
  }

  /** The caller's own circle, locked `FOR UPDATE` (`_owner_circle_for_invite`). */
  async lockOwnedCircle(tx: InviteExecutor, callerId: string): Promise<string | undefined> {
    const result = await tx.execute<{ id: string }>(sql`
      select sc.id::text as id
        from public.safety_circles sc
       where sc.owner_id = ${callerId}::uuid
         for update`);
    return result.rows[0]?.id;
  }

  /** `available` of `_circle_invite_capacity_json(circle)` (active + valid pending, owner excluded). */
  async availableSlots(tx: InviteExecutor, circleId: string): Promise<number> {
    const result = await tx.execute<{ available: number | null }>(sql`
      select (${capacityJsonSql(sql`${circleId}::uuid`)}->>'available')::integer as available`);
    return result.rows[0].available ?? 0;
  }

  /** The row of `phone` in the circle, locked (the invite functions' `select ... for update`). */
  async lockMemberByPhone(
    tx: InviteExecutor,
    circleId: string,
    phone: string,
  ): Promise<LockedMemberRow | undefined> {
    return this.lockOne(tx, sql`m.circle_id = ${circleId}::uuid and m.phone = ${phone}`);
  }

  /** `resend_circle_invite`: the row `memberId` of the caller's circle, locked. */
  async lockMemberInCircle(
    tx: InviteExecutor,
    memberId: string,
    circleId: string,
  ): Promise<LockedMemberRow | undefined> {
    return this.lockOne(tx, sql`m.id = ${memberId}::uuid and m.circle_id = ${circleId}::uuid`);
  }

  /** `cancel_circle_invite`: the row `memberId` of any circle, locked (no circle lock first). */
  async lockMember(tx: InviteExecutor, memberId: string): Promise<LockedMemberRow | undefined> {
    return this.lockOne(tx, sql`m.id = ${memberId}::uuid`);
  }

  /** `circle.owner`: the caller owns the circle. */
  async isCircleOwner(tx: InviteExecutor, circleId: string, callerId: string): Promise<boolean> {
    const result = await tx.execute<{ owner: boolean }>(
      sql`select ${circleOwner.where({ circleId: sql`${circleId}::uuid`, callerId })} as owner`,
    );
    return result.rows[0].owner === true;
  }

  /** The elements of `p_invites` in array order: object or not, and `->> 'display_name'/'phone'`. */
  async batchItems(tx: InviteExecutor, invites: unknown[]): Promise<BatchItemRow[]> {
    const result = await tx.execute<BatchItemRow>(sql`
      select (jsonb_typeof(t.elem) = 'object') as is_object,
             t.elem->>'display_name' as display_name,
             t.elem->>'phone' as phone
        from jsonb_array_elements(${JSON.stringify(invites)}::jsonb) with ordinality as t(elem, ord)
       order by t.ord`);
    return result.rows;
  }

  /**
   * The phone invite insert of `invite_circle_member_by_phone` / `invite_circle_members_by_phone`:
   * a pending member row with a token and a 7-day expiry. A clash on any unique index
   * (`(circle_id, phone)`, the token) inserts nothing and returns undefined, which is what the SQL's
   * `exception when unique_violation` branch sees. The capacity trigger still runs (raw
   * `circle_full`).
   */
  async insertPhoneInvite(
    tx: InviteExecutor,
    values: PhoneInsert,
    inviteUrlBase: string,
  ): Promise<MemberInvitePayload | undefined> {
    const result = await tx.execute<{ body: MemberInvitePayload }>(sql`
      insert into public.safety_circle_members as scm (
        circle_id, role, status, display_name, relationship, phone, email, user_id, invited_at,
        invite_token, invite_expires_at
      )
      values (
        ${values.circleId}::uuid, 'member', 'pending', ${values.displayName},
        ${values.relationship}::text, ${values.phone}, null, null, now(), ${values.token},
        now() + interval '7 days'
      )
      on conflict do nothing
      returning ${payloadSql(inviteUrlBase, false)} as body`);
    return result.rows[0]?.body;
  }

  /**
   * The link invite insert of `create_circle_invite_link`: `phone` null. Not guarded against unique
   * clashes, as the SQL (a token clash is an error).
   */
  async insertLinkInvite(
    tx: InviteExecutor,
    circleId: string,
    displayName: string,
    token: string,
    inviteUrlBase: string,
  ): Promise<MemberInvitePayload> {
    const result = await tx.execute<{ body: MemberInvitePayload }>(sql`
      insert into public.safety_circle_members as scm (
        circle_id, role, status, display_name, relationship, phone, email, user_id, invited_at,
        invite_token, invite_expires_at
      )
      values (
        ${circleId}::uuid, 'member', 'pending', ${displayName}, null, null, null, null, now(),
        ${token}, now() + interval '7 days'
      )
      returning ${payloadSql(inviteUrlBase, false)} as body`);
    return result.rows[0].body;
  }

  /**
   * The write of `_refresh_circle_invite` (baseline 20261019160000): same row, `pending`, no user,
   * new token, `invited_at = now()`, 7-day expiry, consumed/canceled cleared. The caller holds the
   * row lock and has run the function's checks.
   */
  async refresh(
    tx: InviteExecutor,
    values: InviteRefresh,
    inviteUrlBase: string,
  ): Promise<MemberInvitePayload> {
    const result = await tx.execute<{ body: MemberInvitePayload }>(sql`
      update public.safety_circle_members as scm
         set display_name = ${values.displayName},
             relationship = ${values.relationship}::text,
             status = 'pending',
             user_id = null,
             invited_at = now(),
             invite_token = ${values.token},
             invite_expires_at = now() + interval '7 days',
             invite_consumed_at = null,
             invite_canceled_at = null,
             updated_at = now()
       where scm.id = ${values.memberId}::uuid
      returning ${payloadSql(inviteUrlBase, true)} as body`);
    return result.rows[0].body;
  }

  /**
   * The write of `cancel_circle_invite`: `declined` + `invite_canceled_at = now()`; the body with
   * `owner_name` = the owner row's stored `display_name` (`_circle_owner_display_name`).
   */
  async cancel(tx: InviteExecutor, memberId: string): Promise<CanceledInviteJson> {
    const result = await tx.execute<{ body: CanceledInviteJson }>(sql`
      update public.safety_circle_members as scm
         set status = 'declined',
             invite_canceled_at = now()
       where scm.id = ${memberId}::uuid
      returning jsonb_build_object(
        'member_id', scm.id,
        'circle_id', scm.circle_id,
        'status', 'canceled',
        'owner_name', (
          select om.display_name
            from public.safety_circle_members om
           where om.circle_id = scm.circle_id
             and om.role = 'owner'
           limit 1
        )
      ) as body`);
    return result.rows[0].body;
  }

  private async lockOne(tx: InviteExecutor, where: SQL): Promise<LockedMemberRow | undefined> {
    const result = await tx.execute<LockedMemberRow>(sql`
      select ${LOCKED_MEMBER_COLUMNS}
        from public.safety_circle_members m
       where ${where}
         for update`);
    return result.rows[0];
  }
}

/**
 * `_circle_invite_payload(m, resent)` over the written row `scm`, except `invite_url`: the
 * configured `INVITE_URL_BASE` (default the SQL's `io.supabase.atlasmobile://invite/`) + token.
 */
function payloadSql(inviteUrlBase: string, resent: boolean): SQL {
  return sql`jsonb_build_object(
    'member_id', scm.id,
    'circle_id', scm.circle_id,
    'status', scm.status,
    'display_name', scm.display_name,
    'relationship', scm.relationship,
    'phone', scm.phone,
    'invite_token', scm.invite_token,
    'invite_url', ${inviteUrlBase}::text || scm.invite_token,
    'invited_at', scm.invited_at,
    'invite_expires_at', scm.invite_expires_at,
    'resent', ${resent}::boolean
  )`;
}
