import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import {
  aliasColumn,
  assertNoActivatedAt,
  circleOwner,
  inviteRecipient,
  membershipActivate,
} from '../../common/policies';
import { type AvatarUrlBase, avatarUrlSql } from '../circles/circles.repository';
import {
  holdsSlotSql,
  inviteLookupStatusSql,
  type InviteLookupStatus,
  memberAlias,
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
  /** Another row of the caller in the circle, any status (the preview `circle_full` claim guard). */
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
function ownerNameSql(circleId: SQL): SQL {
  return sql`(select om.display_name
                from public.safety_circle_members om
               where om.circle_id = ${circleId}
                 and om.role = 'owner'
               limit 1)`;
}

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
 * its claim), accept and decline. Lock order is the SQL functions': accept locks the token's
 * `safety_circles` row first, then the member row; preview and decline lock only the member row.
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
