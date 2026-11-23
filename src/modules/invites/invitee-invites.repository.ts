import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import {
  aliasColumn,
  assertNoActivatedAt,
  circleOwner,
  inviteRecipient,
  membershipActivate,
  normalizeE164Sql,
} from '../../common/policies';
import {
  type AvatarUrlBase,
  avatarUrlSql,
  circleOwnerNameSql,
} from '../circles/circles.repository';
import {
  endedSql,
  holdsSlotSql,
  inviteLookupStatusSql,
  type InviteLookupStatus,
  memberAlias,
  notEndedSql,
} from '../circles/invite-slots';
import type { InviteExecutor } from './owner-invites.repository';

/** `{status, invite_expires_at}` of `lookup_circle_invite` (spec §7.3), as Postgres builds it. */
export type InviteLookupJson = Record<string, unknown> & {
  status: InviteLookupStatus;
  invite_expires_at: string | null;
};

/** The body of `preview_circle_invite` (spec §7.3), as Postgres builds it. */
export type InvitePreviewJson = Record<string, unknown> & {
  status: string;
  invite_expires_at: string | null;
  member_id: string | null;
  circle_id: string | null;
  owner_name: string | null;
  invited_at: string | null;
  /** SQL three-valued: `null` where the function's boolean expression is null (see the service). */
  claimed: boolean | null;
  recipient_ok: boolean;
  owner_avatar_url: string | null;
};

/** The body of `accept_circle_invite` / `decline_circle_invite` (spec §7.3). */
export type InviteDecisionJson = Record<string, unknown> & {
  circle_id: string;
  member_id: string;
  status: 'active' | 'declined';
  owner_name: string | null;
};

/** The invite row of a token, locked `FOR UPDATE` (the functions' `select * ... for update`). */
export interface LockedInviteRow extends Record<string, unknown> {
  id: string;
  circle_id: string;
  /** `phone is not null`: a phone invite (else a link invite). For the audit channel only. */
  phone_invite: boolean;
  /** `user_id is null`. */
  unclaimed: boolean;
  /** `m.status = 'active' and m.user_id = uid` (null `user_id` → false, as plpgsql's `if`). */
  active_for_caller: boolean;
}

/**
 * The checks of the invitee functions on the locked row, evaluated by Postgres in a statement AFTER
 * the lock (as the functions do, each check its own statement): a writer that committed while this
 * one waited for the lock is seen.
 */
export interface InviteChecks extends Record<string, unknown> {
  /** `_circle_invite_lookup_status(m)`. */
  lookup_status: InviteLookupStatus;
  /** `_circle_invite_recipient_ok(m, uid, auth_phone)` (`invite.recipient`). Never null. */
  recipient_ok: boolean;
  /** `m.user_id = uid`: SQL three-valued (null when the row has no user). */
  mine: boolean | null;
  /** `safety_circles.owner_id = uid` of the row's circle (`circle.owner`). */
  caller_owns_circle: boolean;
  /** `_circle_has_active_membership(m.circle_id, uid, m.id)`: another active row of the caller. */
  other_active: boolean;
  /**
   * Another row of the caller in the circle, any status but an ended one (the preview
   * `circle_full` claim guard; D44: an ended row is history, where the SQL has no row at all).
   */
  other_row: boolean;
  /** `_circle_accept_used_after(m.circle_id, m.id)`: other slot holders + 1. */
  used_after: number;
}

/** The values the preview body is built from (the function's local variables). */
export interface PreviewParts {
  status: string;
  includeRow: boolean;
  showOwner: boolean;
  claimed: boolean | null;
  recipientOk: boolean;
}

/**
 * `_member_profile_name(uid)` (baseline 20261117120000): the user's `profiles.full_name`, trimmed
 * (Postgres `trim`, spaces only), null when there is no profile or the name is empty. Only the
 * name: never another profile column. `uid` is a uuid SQL expression.
 */
export function memberProfileNameSql(uid: SQL): SQL {
  return sql`(select nullif(trim(pn_p.full_name), '')
                from public.profiles pn_p
               where pn_p.id = ${uid})`;
}

/** `_circle_owner_display_name(circle)`: the owner row's STORED `display_name` (not the profile). */
const ownerNameSql = circleOwnerNameSql;

/** One element of `list_my_circle_invites` (spec §7.3), exactly as the SQL builds it. */
export type IncomingInviteJson = Record<string, unknown> & {
  member_id: string;
  circle_id: string;
  status: 'pending' | 'expired' | 'canceled';
  owner_name: string | null;
  invited_at: string;
  invite_expires_at: string | null;
  invite_token: string | null;
  /** SCRUM-33 (D46, additive; not in the SQL): the circle owner's public avatar URL, or null. */
  owner_avatar_url: string | null;
};

/**
 * The rows `list_my_circle_invites` considers the caller's (final: baseline 20261019170000), over
 * the member alias `scm`: `role = 'member'`, not an ended membership (D44: `removed` / `left` rows
 * are history and never listed) and either claimed by the caller (`user_id = uid`) or
 * unclaimed with a phone equal, after `_normalize_e164`, to the caller's normalized Auth phone (no
 * Auth phone: claimed rows only). `authPhone` is `auth.users.phone` as stored; it is normalized
 * here (the function normalizes it in `_auth_user_phone` and again in the comparison, which changes
 * nothing).
 */
function incomingInviteMatchSql(callerId: string, authPhone: string | null): SQL {
  const callerPhone = normalizeE164Sql(sql`${authPhone}::text`);
  return sql`(scm.role = 'member'
     and ${notEndedSql(sql`scm.status`)}
     and (
       scm.user_id = ${callerId}::uuid
       or (
         scm.user_id is null
         and scm.phone is not null
         and ${callerPhone} is not null
         and ${normalizeE164Sql(sql`scm.phone`)} = ${callerPhone}
       )
     ))`;
}

/**
 * Advisory-lock namespace of the invitee writes of one user (`pg_advisory_xact_lock(ns,
 * hashtext(user_id))`, D41): the API's preview, accept, decline and incoming-list claim of one
 * caller run one after the other. A hash collision only serializes two users' calls.
 */
const INVITEE_CALLER_LOCK_NAMESPACE = 4402;

const NOT_FOUND_LOOKUP = sql`jsonb_build_object('status', 'not_found', 'invite_expires_at', null)`;

const NOT_FOUND_PREVIEW = sql`jsonb_build_object(
  'status', 'not_found',
  'invite_expires_at', null,
  'member_id', null,
  'circle_id', null,
  'owner_name', null,
  'invited_at', null,
  'claimed', false,
  'recipient_ok', false,
  'owner_avatar_url', null
)`;

/**
 * The SQL of the invitee's side of an invitation (API-100-29/30, spec §7.3): lookup, preview (with
 * its claim), accept and decline. Lock order (D18, D41): accept and preview lock the token's
 * `safety_circles` row first, then, in one `ctid`-ordered statement, the token's member row and the
 * caller's other non-active rows of that circle ({@link InviteeInvitesRepository.lockInviteForClaim});
 * decline locks only the member row (as the SQL). The SQL preview takes no circle lock; the API's
 * does, because since D41 its claim may also release the caller's finished rows of the circle.
 * JSON is built by Postgres with the functions' `jsonb_build_object` (same keys, key order, nulls
 * and timestamp text; the caller's transaction runs in UTC). The only write that makes a row
 * `active` is {@link acceptWrite}, guarded by `membership.activate` (path `invite_accept`); none of
 * these writes ever sets `activated_at` (its trigger stamps it).
 */
@Injectable()
export class InviteeInvitesRepository {
  /** Timestamps in JSON as UTC text (`...+00:00`), as the hosted project's sessions write them. */
  async useUtcTimestamps(tx: InviteExecutor): Promise<void> {
    await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
  }

  /**
   * `lookup_circle_invite(token)`: `{status, invite_expires_at}` of the row holding `token`, or
   * `not_found` with a null expiry. Reads no other column; takes no lock.
   */
  async lookup(tx: InviteExecutor, token: string): Promise<InviteLookupJson> {
    const m = memberAlias('m');
    const result = await tx.execute<{ body: InviteLookupJson }>(sql`
      select coalesce(
               (select jsonb_build_object(
                         'status', ${inviteLookupStatusSql(m)},
                         'invite_expires_at', m.invite_expires_at
                       )
                  from public.safety_circle_members m
                 where m.invite_token = ${token}),
               ${NOT_FOUND_LOOKUP}
             ) as body`);
    return result.rows[0].body;
  }

  /**
   * D41: the caller's invitee lock ({@link INVITEE_CALLER_LOCK_NAMESPACE}), taken FIRST in the
   * transaction (before the circle and any member row; the reads before it take no lock). Why: the
   * API's preview / accept and its incoming-list claim each lock several member rows of the caller
   * in `ctid` order, and a row moved by a concurrent UPDATE (a cancel, a release) can make two of
   * them see different orders; serializing one caller's invitee transactions removes that cycle.
   * Owner writes, remove, leave and submit do not take it, and a holder of it only ever waits for
   * locks those take in their own D18 order (circle, then member rows), so it adds no new cycle.
   * Not in the SQL functions (they take no such lock).
   */
  async lockCaller(tx: InviteExecutor, callerId: string): Promise<void> {
    await tx.execute(sql`
      select pg_advisory_xact_lock(${INVITEE_CALLER_LOCK_NAMESPACE}::int,
                                   hashtext(${callerId}::text))`);
  }

  /** `_auth_user_phone(uid)` before normalization: `auth.users.phone` of the caller (null if none). */
  async authPhone(tx: InviteExecutor, callerId: string): Promise<string | null> {
    const result = await tx.execute<{ phone: string | null }>(sql`
      select u.phone from auth.users u where u.id = ${callerId}::uuid`);
    return result.rows[0]?.phone ?? null;
  }

  /** `accept_circle_invite`'s first read: the circle of the token's row (no lock). */
  async circleOfToken(tx: InviteExecutor, token: string): Promise<string | undefined> {
    const result = await tx.execute<{ circle_id: string }>(sql`
      select scm.circle_id::text as circle_id
        from public.safety_circle_members scm
       where scm.invite_token = ${token}`);
    return result.rows[0]?.circle_id;
  }

  /** The circle row locked `FOR UPDATE` (accept's first lock). False when it does not exist. */
  async lockCircle(tx: InviteExecutor, circleId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      select 1 from public.safety_circles sc where sc.id = ${circleId}::uuid for update`);
    return result.rows.length > 0;
  }

  /** The member row holding `token`, locked `FOR UPDATE`. */
  async lockByToken(
    tx: InviteExecutor,
    token: string,
    callerId: string,
  ): Promise<LockedInviteRow | undefined> {
    const result = await tx.execute<LockedInviteRow>(sql`
      select m.id::text as id,
             m.circle_id::text as circle_id,
             (m.phone is not null) as phone_invite,
             (m.user_id is null) as unclaimed,
             coalesce(m.status = 'active' and m.user_id = ${callerId}::uuid, false)
               as active_for_caller
        from public.safety_circle_members m
       where m.invite_token = ${token}
         for update`);
    return result.rows[0];
  }

  /**
   * The member row holding `token` in circle `circleId` (the circle already locked by the caller,
   * D18: circle before member rows), locked `FOR UPDATE` in ONE statement in `ctid` order together
   * with (D41):
   * - the caller's own non-`active` member rows of that circle: the rows
   *   {@link releaseFinishedRows} may release;
   * - the circle's unclaimed stored-`pending` member rows: every row a writer that takes no circle
   *   lock (the SQL `preview_circle_invite`, the claim loops of `list_my_circle_invites` in SQL and
   *   in the API, `decline_circle_invite`) could turn into a row of the caller while this
   *   transaction runs.
   * Why the second set: a release makes the caller's old `(circle_id, user_id)` index entry dead but
   * uncommitted, so a concurrent claim of the caller in this circle waits for this transaction; if
   * this transaction's own claim then waited for that writer's uncommitted entry, the two would
   * deadlock (40P01) on the unique index. Holding those rows first means such a writer either
   * finished before (its row is then committed and seen) or waits for this transaction at its row
   * lock, before writing anything. The order is the physical order the claim loops also use
   * ({@link lockClaimCandidates}; the SQL loop's sequential scan), so two of these lockers never
   * take two rows in opposite orders. Never locked here: the owner row and `active` rows (SOS
   * submit takes active rows `FOR KEY SHARE`, D14; the caller's active row is only read by
   * {@link checks}). Undefined when no row holds `token` in that circle (a token rotated meanwhile).
   *
   * `mode` `'nowait'` (`FOR UPDATE NOWAIT`) raises 55P03 instead of waiting for a row another
   * transaction holds: the service calls it in a savepoint and retries
   * (`InviteeInvitesService.lockRowsWithoutWaiting`), so it never waits for one member row while
   * holding another. A `ctid` order cannot be relied on alone: a concurrent UPDATE moves a tuple,
   * so the SQL claim loop (sequential scan, locking as it goes) can meet the same two rows in the
   * opposite order (a 40P01 seen under load, D41).
   */
  async lockInviteForClaim(
    tx: InviteExecutor,
    circleId: string,
    token: string,
    callerId: string,
    mode: RowLockMode = 'wait',
  ): Promise<LockedInviteRow | undefined> {
    const result = await tx.execute<LockedInviteRow & { is_token: boolean }>(sql`
      select m.id::text as id,
             m.circle_id::text as circle_id,
             (m.phone is not null) as phone_invite,
             (m.user_id is null) as unclaimed,
             coalesce(m.status = 'active' and m.user_id = ${callerId}::uuid, false)
               as active_for_caller,
             coalesce(m.invite_token = ${token}, false) as is_token
        from public.safety_circle_members m
       where m.circle_id = ${circleId}::uuid
         and (
           m.invite_token = ${token}
           or (
             m.role = 'member'
             and m.status <> 'active'
             and (m.user_id = ${callerId}::uuid or (m.user_id is null and m.status = 'pending'))
           )
         )
       order by m.ctid
         ${forUpdate(mode)}`);
    const row = result.rows.find((r) => r.is_token);
    if (!row) return undefined;
    return {
      id: row.id,
      circle_id: row.circle_id,
      phone_invite: row.phone_invite,
      unclaimed: row.unclaimed,
      active_for_caller: row.active_for_caller,
    };
  }

  /**
   * D41 (approved by Dawit 2026-11-21): frees the caller's FINISHED rows of the circle before a new
   * claim, so an old decline or cancel no longer blocks a new invite with the `(circle_id, user_id)`
   * unique index. Finished = lookup status `canceled` (declined, or `invite_canceled_at` set) or
   * `expired`, and (D44) an ENDED membership (`removed` / `left`): rejoining after a remove or a
   * leave needs a new invitation, and its claim releases the old history row. The row keeps everything else (status, names, phone, token, times) as history; only
   * `user_id = null, updated_at = now()` is written. Never the owner row, never an `active` or a
   * still-valid pending row, never `keepMemberId` (the row being claimed). Call it only with the
   * circle locked and {@link lockInviteForClaim} done, in the claim's transaction. Returns the number
   * of rows released. The capacity trigger does not fire a circle lock for these rows (none of them
   * becomes a newly occupying row).
   */
  async releaseFinishedRows(
    tx: InviteExecutor,
    circleId: string,
    callerId: string,
    keepMemberId: string,
  ): Promise<number> {
    const x = memberAlias('x');
    const result = await tx.execute(sql`
      update public.safety_circle_members as x
         set user_id = null,
             updated_at = now()
       where x.circle_id = ${circleId}::uuid
         and x.user_id = ${callerId}::uuid
         and x.role = 'member'
         and x.status <> 'active'
         and x.id <> ${keepMemberId}::uuid
         and (${inviteLookupStatusSql(x)} in ('canceled', 'expired') or ${endedSql(x.status)})`);
    return result.rowCount ?? 0;
  }

  /** {@link InviteChecks} of the locked row `memberId` for the caller. */
  async checks(
    tx: InviteExecutor,
    memberId: string,
    callerId: string,
    authPhone: string | null,
  ): Promise<InviteChecks> {
    const m = memberAlias('m');
    const x = memberAlias('x');
    const caller = sql`${callerId}::uuid`;
    const recipient = inviteRecipient.where({
      callerId,
      authPhone,
      member: { userId: aliasColumn('m', 'user_id'), phone: aliasColumn('m', 'phone') },
    });
    const result = await tx.execute<InviteChecks>(sql`
      select ${inviteLookupStatusSql(m)} as lookup_status,
             coalesce(${recipient}, false) as recipient_ok,
             (m.user_id = ${caller}) as mine,
             coalesce(${circleOwner.where({ circleId: aliasColumn('m', 'circle_id'), callerId })},
                      false) as caller_owns_circle,
             exists (
               select 1 from public.safety_circle_members x
                where x.circle_id = m.circle_id
                  and x.user_id = ${caller}
                  and x.status = 'active'
                  and x.id is distinct from m.id
             ) as other_active,
             exists (
               select 1 from public.safety_circle_members x
                where x.circle_id = m.circle_id
                  and x.user_id = ${caller}
                  and x.id <> m.id
                  and ${notEndedSql(x.status)}
             ) as other_row,
             (
               select (count(*) filter (where ${holdsSlotSql(x)} and x.id is distinct from m.id)
                       + 1)::integer
                 from public.safety_circle_members x
                where x.circle_id = m.circle_id
             ) as used_after
        from public.safety_circle_members m
       where m.id = ${memberId}::uuid`);
    return result.rows[0];
  }

  /**
   * The preview claim: `user_id = uid` (status stays `pending`). Throws the unique violation of
   * `(circle_id, user_id)` for the caller to handle (run it in a savepoint).
   */
  async claim(tx: InviteExecutor, memberId: string, callerId: string): Promise<void> {
    await tx.execute(sql`
      update public.safety_circle_members as scm
         set user_id = ${callerId}::uuid,
             updated_at = now()
       where scm.id = ${memberId}::uuid`);
  }

  /** The not-found body of `preview_circle_invite` (all other keys null/false). */
  async previewNotFound(tx: InviteExecutor): Promise<InvitePreviewJson> {
    const result = await tx.execute<{ body: InvitePreviewJson }>(
      sql`select ${NOT_FOUND_PREVIEW} as body`,
    );
    return result.rows[0].body;
  }

  /**
   * The body of `preview_circle_invite` for row `memberId` and the function's decisions: the row ids
   * and `invited_at` only when `includeRow`; `owner_name` (stored owner row name) and
   * `owner_avatar_url` (the owner's `profiles.avatar_path` as a public URL, `_member_avatar_url`)
   * only when `showOwner`.
   */
  async previewBody(
    tx: InviteExecutor,
    memberId: string,
    parts: PreviewParts,
    avatars: AvatarUrlBase,
  ): Promise<InvitePreviewJson> {
    const include = sql`${parts.includeRow}::boolean`;
    const show = sql`${parts.showOwner}::boolean`;
    const ownerAvatar = sql`(select ${avatarUrlSql(sql`ow_p.avatar_path`, avatars)}
                               from public.profiles ow_p
                              where ow_p.id = sc.owner_id)`;
    const result = await tx.execute<{ body: InvitePreviewJson }>(sql`
      select jsonb_build_object(
               'status', ${parts.status}::text,
               'invite_expires_at', m.invite_expires_at,
               'member_id', case when ${include} then m.id else null end,
               'circle_id', case when ${include} then m.circle_id else null end,
               'owner_name', case when ${show} then ${ownerNameSql(sql`m.circle_id`)} else null end,
               'invited_at', case when ${include} then m.invited_at else null end,
               'claimed', ${parts.claimed}::boolean,
               'recipient_ok', ${parts.recipientOk}::boolean,
               'owner_avatar_url', case when ${show} then ${ownerAvatar} else null end
             ) as body
        from public.safety_circle_members m
        join public.safety_circles sc on sc.id = m.circle_id
       where m.id = ${memberId}::uuid`);
    return result.rows[0].body;
  }

  /** `accept_circle_invite`'s answer without a write (the row is already active for the caller). */
  async activeBody(tx: InviteExecutor, memberId: string): Promise<InviteDecisionJson> {
    const result = await tx.execute<{ body: InviteDecisionJson }>(sql`
      select ${decisionJsonSql(sql`'active'`)} as body
        from public.safety_circle_members scm
       where scm.id = ${memberId}::uuid`);
    return result.rows[0].body;
  }

  /**
   * The write of `accept_circle_invite` (final: baseline 20261117120000): `user_id = uid`,
   * `status = 'active'`, `display_name` = the accepter's profile name ({@link memberProfileNameSql})
   * or the stored one, `invite_consumed_at = now()`, `invite_canceled_at = null`. `activated_at` is
   * never written (trigger `safety_circle_members_set_activated_at`); the UPDATE is guarded by
   * `membership.activate` for path `invite_accept`. Undefined when the guard matched no row. Throws
   * the unique violation of `(circle_id, user_id)` for the caller to handle (savepoint).
   */
  async acceptWrite(
    tx: InviteExecutor,
    memberId: string,
    callerId: string,
  ): Promise<InviteDecisionJson | undefined> {
    const caller = sql`${callerId}::uuid`;
    const set: Record<string, SQL> = {
      user_id: caller,
      status: sql`'active'`,
      display_name: sql`coalesce(${memberProfileNameSql(caller)}, scm.display_name)`,
      invite_consumed_at: sql`now()`,
      invite_canceled_at: sql`null`,
      updated_at: sql`now()`,
    };
    assertNoActivatedAt(set);
    const guard = membershipActivate.where({
      path: 'invite_accept',
      callerId,
      member: {
        role: aliasColumn('scm', 'role'),
        userId: aliasColumn('scm', 'user_id'),
        circleId: aliasColumn('scm', 'circle_id'),
      },
    });
    const result = await tx.execute<{ body: InviteDecisionJson }>(sql`
      update public.safety_circle_members as scm
         set ${setClause(set)}
       where scm.id = ${memberId}::uuid
         and ${guard}
      returning ${decisionJsonSql(sql`scm.status`)} as body`);
    return result.rows[0]?.body;
  }

  /**
   * The claim loop's rows of `list_my_circle_invites`: the caller's stored-`pending` rows
   * ({@link incomingInviteMatchSql}), locked `FOR UPDATE` (member rows only, no circle lock, as the
   * function). Lock order: the function's `for m in select ... for update loop` has no `ORDER BY`;
   * its predicate (an OR across `user_id` and a function of `phone`) can use no index, so Postgres
   * scans the table sequentially and locks the rows in physical order. The API sorts by `ctid` to lock
   * them in that same order, so an API and an SQL call of the same caller cannot lock two rows in
   * opposite orders. A row changed while this waited is re-checked against the predicate (a row
   * accepted or declined meanwhile is no longer `pending` and drops out), as in the function.
   * `mode` `'nowait'`: as {@link lockInviteForClaim} (D41; the `ctid` order alone does not hold
   * when a concurrent UPDATE moves a tuple).
   */
  async lockClaimCandidates(
    tx: InviteExecutor,
    callerId: string,
    authPhone: string | null,
    mode: RowLockMode = 'wait',
  ): Promise<string[]> {
    const result = await tx.execute<{ id: string }>(sql`
      select scm.id::text as id
        from public.safety_circle_members scm
       where ${incomingInviteMatchSql(callerId, authPhone)}
         and scm.status = 'pending'
       order by scm.ctid
         ${forUpdate(mode)}`);
    return result.rows.map((row) => row.id);
  }

  /**
   * The answer of `list_my_circle_invites` (after its claims), built by Postgres with the function's
   * `jsonb_build_object` (keys, key order, nulls and timestamp text): the caller's rows
   * ({@link incomingInviteMatchSql}) whose lookup status is `pending`, `expired` or `canceled`
   * (`consumed` and `not_found` excluded); `invite_token` only while `pending`; `owner_name` = the
   * owner row's stored name. SCRUM-33 (D46, additive, not in the SQL): `owner_avatar_url` = the
   * circle owner's `profiles.avatar_path` as a public URL ({@link avatarUrlSql}, the rule of the
   * preview's `owner_avatar_url` and the member list's `avatar_url`), null without a profile or a
   * path; on every listed row, like `owner_name`. Order: the function's `(payload->>'invited_at') desc` (the same
   * expression, so the same order); equal `invited_at` values are in no defined order in the SQL,
   * the API then orders by `member_id`.
   */
  async listIncoming(
    tx: InviteExecutor,
    callerId: string,
    authPhone: string | null,
    avatars: AvatarUrlBase,
  ): Promise<IncomingInviteJson[]> {
    const m = memberAlias('scm');
    const status = inviteLookupStatusSql(m);
    const ownerAvatar = sql`(select ${avatarUrlSql(sql`ow_p.avatar_path`, avatars)}
                               from public.safety_circles ow_c
                               join public.profiles ow_p on ow_p.id = ow_c.owner_id
                              where ow_c.id = scm.circle_id)`;
    const result = await tx.execute<{ body: IncomingInviteJson[] }>(sql`
      select coalesce(
               jsonb_agg(listed.payload
                         order by (listed.payload->>'invited_at') desc, listed.member_id),
               '[]'::jsonb
             ) as body
        from (
          select scm.id as member_id,
                 jsonb_build_object(
                   'member_id', scm.id,
                   'circle_id', scm.circle_id,
                   'status', ${status},
                   'owner_name', ${ownerNameSql(sql`scm.circle_id`)},
                   'invited_at', scm.invited_at,
                   'invite_expires_at', scm.invite_expires_at,
                   'invite_token', case when ${status} = 'pending' then scm.invite_token else null end,
                   'owner_avatar_url', ${ownerAvatar}
                 ) as payload
            from public.safety_circle_members scm
           where ${incomingInviteMatchSql(callerId, authPhone)}
             and ${status} in ('pending', 'expired', 'canceled')
        ) listed`);
    return result.rows[0].body;
  }

  /**
   * The write of `decline_circle_invite` (final: baseline 20261021130000): `status = 'declined'`,
   * `invite_canceled_at = now()`, `invite_consumed_at = null`, and `user_id = uid` when
   * `withUser` (the function first tries with the user, then, after a unique clash, without it).
   */
  async declineWrite(
    tx: InviteExecutor,
    memberId: string,
    callerId: string,
    withUser: boolean,
  ): Promise<InviteDecisionJson> {
    const set: Record<string, SQL> = {
      ...(withUser ? { user_id: sql`${callerId}::uuid` } : {}),
      status: sql`'declined'`,
      invite_canceled_at: sql`now()`,
      invite_consumed_at: sql`null`,
      updated_at: sql`now()`,
    };
    assertNoActivatedAt(set);
    const result = await tx.execute<{ body: InviteDecisionJson }>(sql`
      update public.safety_circle_members as scm
         set ${setClause(set)}
       where scm.id = ${memberId}::uuid
      returning ${decisionJsonSql(sql`scm.status`)} as body`);
    return result.rows[0].body;
  }
}

/** `'wait'`: `FOR UPDATE` (wait for the holder); `'nowait'`: `FOR UPDATE NOWAIT` (55P03 instead). */
export type RowLockMode = 'wait' | 'nowait';

function forUpdate(mode: RowLockMode): SQL {
  return mode === 'nowait' ? sql`for update nowait` : sql`for update`;
}

/** `col = value, ...` of an UPDATE (column names are constants of this file). */
function setClause(set: Record<string, SQL>): SQL {
  return sql.join(
    Object.entries(set).map(([column, value]) => sql`${sql.identifier(column)} = ${value}`),
    sql`, `,
  );
}

/** `{circle_id, member_id, status, owner_name}` over the row `scm` (the functions' answer). */
function decisionJsonSql(status: SQL): SQL {
  return sql`jsonb_build_object(
    'circle_id', scm.circle_id,
    'member_id', scm.id,
    'status', ${status},
    'owner_name', ${ownerNameSql(sql`scm.circle_id`)}
  )`;
}
