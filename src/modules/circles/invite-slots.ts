import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

import { type PgTimestamp, pgTimestampMicros } from '../../db/pg-timestamp';
import { safetyCircleMembers } from '../../db/schema';
import { aliasColumn } from '../../common/policies';

/**
 * Capacity and invite status of `safety_circle_members` rows (spec §3 glossary "valid pending",
 * §5.3, rule 8), shared by every Phase 2 story (API-100-24 AC3). Each rule exists twice, kept equal by
 * tests (`invite-slots.spec.ts`, `circles-capacity.int-spec.ts`):
 * - a TypeScript function for a row already loaded (Drizzle `mode: 'string'` columns), with `now` =
 *   the database's `now()` (transaction time) as text, compared at microsecond precision;
 * - a SQL predicate/expression for lists, counts and guarded writes.
 *
 * SQL parity (final definitions, baseline migration 20261117120000 and 20261019130000):
 * - {@link holdsSlot} = `_circle_invite_holds_slot(m)`;
 * - {@link inviteLookupStatus} = `_circle_invite_lookup_status(m)`;
 * - {@link CIRCLE_MEMBER_LIMIT} = `_circle_member_limit()`.
 * The API never calls those internal SQL helpers; it evaluates the same rules itself.
 *
 * Time: `invited_at + interval '7 days'` depends on the session time zone across a DST change. The
 * API runs these in UTC (as PostgREST does on the hosted project), where 7 days is exactly 168 hours,
 * which is what the TypeScript form adds.
 */

/** Trusted-member slots per circle, owner excluded (`_circle_member_limit()`, rule 8). */
export const CIRCLE_MEMBER_LIMIT = 5;

/**
 * D44 (SCRUM-30/31): the stored statuses of a membership that ENDED: `removed` (the owner removed an
 * active member) and `left` (the member left). Such a row is kept as history only: it holds no slot,
 * passes no membership check, carries no usable invite token, and the API never shows it (member
 * lists, joined circles, incoming invites, token lookups).
 */
export const ENDED_MEMBER_STATUSES = ['removed', 'left'] as const;
export type EndedMemberStatus = (typeof ENDED_MEMBER_STATUSES)[number];

/** `<status> not in ('removed', 'left')` for a status column (D44: the row is not history). */
export function notEndedSql(status: SQLWrapper): SQL {
  return sql`(${status} not in ('removed', 'left'))`;
}

/** `<status> in ('removed', 'left')` for a status column (D44: an ended membership). */
export function endedSql(status: SQLWrapper): SQL {
  return sql`(${status} in ('removed', 'left'))`;
}

/** Invite lifetime when `invite_expires_at` is null (`invited_at + interval '7 days'`, in UTC). */
export const INVITE_DEFAULT_LIFETIME_MICROS = 7n * 86_400n * 1_000_000n;

/** The columns the rules read (Drizzle names). */
export interface SlotRow {
  role: string;
  status: string;
  invitedAt: PgTimestamp;
  inviteExpiresAt: PgTimestamp | null;
  inviteCanceledAt: PgTimestamp | null;
  inviteConsumedAt: PgTimestamp | null;
}

/** `_circle_invite_lookup_status` values (spec §5.3). */
export type InviteLookupStatus = 'canceled' | 'consumed' | 'expired' | 'pending' | 'not_found';

/** `coalesce(invite_expires_at, invited_at + interval '7 days')` in microseconds. */
function expiryMicros(row: SlotRow): bigint {
  return row.inviteExpiresAt !== null
    ? pgTimestampMicros(row.inviteExpiresAt)
    : pgTimestampMicros(row.invitedAt) + INVITE_DEFAULT_LIFETIME_MICROS;
}

/**
 * Spec "valid pending" / "holds a slot" (`_circle_invite_holds_slot`): role `member` and either
 * `active`, or `pending` with no cancel, no consume and `coalesce(invite_expires_at, invited_at + 7
 * days) > now`. `now` is the database's `now()` of the current transaction.
 */
export function holdsSlot(row: SlotRow, now: PgTimestamp): boolean {
  if (row.role !== 'member') return false;
  if (row.status === 'active') return true;
  return (
    row.status === 'pending' &&
    row.inviteCanceledAt === null &&
    row.inviteConsumedAt === null &&
    expiryMicros(row) > pgTimestampMicros(now)
  );
}

/** `_circle_invite_lookup_status(m)`: first match wins (spec §5.3). */
export function inviteLookupStatus(row: SlotRow, now: PgTimestamp): InviteLookupStatus {
  if (row.inviteCanceledAt !== null || row.status === 'declined') return 'canceled';
  if (row.inviteConsumedAt !== null || row.status === 'active') return 'consumed';
  if (expiryMicros(row) <= pgTimestampMicros(now)) return 'expired';
  if (row.status === 'pending') return 'pending';
  return 'not_found';
}

/**
 * The `status` of the member list (`list_circle_members`, fix #14): the stored status, except a
 * stored `pending` row whose lookup status is `expired` is shown as `expired`.
 */
export function shownMemberStatus(row: SlotRow, now: PgTimestamp): string {
  return row.status === 'pending' && inviteLookupStatus(row, now) === 'expired'
    ? 'expired'
    : row.status;
}

/** The Capacity numbers (spec §7.0) from the two counts. */
export function capacityFromCounts(activeCount: number, pendingCount: number) {
  const used = activeCount + pendingCount;
  return {
    limit: CIRCLE_MEMBER_LIMIT,
    active_count: activeCount,
    pending_count: pendingCount,
    used,
    available: Math.max(0, CIRCLE_MEMBER_LIMIT - used),
  };
}

// ---------------------------------------------------------------------------------------------------
// SQL forms
// ---------------------------------------------------------------------------------------------------

/** The member-row columns the SQL forms read: table columns, or a table alias (see {@link memberAlias}). */
export interface SlotRowRef {
  role: SQLWrapper;
  status: SQLWrapper;
  invitedAt: SQLWrapper;
  inviteExpiresAt: SQLWrapper;
  inviteCanceledAt: SQLWrapper;
  inviteConsumedAt: SQLWrapper;
}

/** The columns of `public.safety_circle_members` itself (Drizzle query builder). */
export const MEMBER_SLOT_COLUMNS: SlotRowRef = {
  role: safetyCircleMembers.role,
  status: safetyCircleMembers.status,
  invitedAt: safetyCircleMembers.invitedAt,
  inviteExpiresAt: safetyCircleMembers.inviteExpiresAt,
  inviteCanceledAt: safetyCircleMembers.inviteCanceledAt,
  inviteConsumedAt: safetyCircleMembers.inviteConsumedAt,
};

/** The same columns of `safety_circle_members` under a constant alias (e.g. `scm`), for raw SQL. */
export function memberAlias(alias: string): SlotRowRef {
  return {
    role: aliasColumn(alias, 'role'),
    status: aliasColumn(alias, 'status'),
    invitedAt: aliasColumn(alias, 'invited_at'),
    inviteExpiresAt: aliasColumn(alias, 'invite_expires_at'),
    inviteCanceledAt: aliasColumn(alias, 'invite_canceled_at'),
    inviteConsumedAt: aliasColumn(alias, 'invite_consumed_at'),
  };
}

/** `coalesce(invite_expires_at, invited_at + interval '7 days')`. */
function expirySql(m: SlotRowRef): SQL {
  return sql`coalesce(${m.inviteExpiresAt}, ${m.invitedAt} + interval '7 days')`;
}

/** {@link holdsSlot} as SQL (the body of `_circle_invite_holds_slot`), against `now()`. */
export function holdsSlotSql(m: SlotRowRef = MEMBER_SLOT_COLUMNS): SQL {
  return sql`(${m.role} = 'member'
     and (
       ${m.status} = 'active'
       or (
         ${m.status} = 'pending'
         and ${m.inviteCanceledAt} is null
         and ${m.inviteConsumedAt} is null
         and ${expirySql(m)} > now()
       )
     ))`;
}

/** {@link inviteLookupStatus} as SQL (`_circle_invite_lookup_status`), against `now()`. */
export function inviteLookupStatusSql(m: SlotRowRef = MEMBER_SLOT_COLUMNS): SQL {
  return sql`(case
      when ${m.inviteCanceledAt} is not null or ${m.status} = 'declined' then 'canceled'
      when ${m.inviteConsumedAt} is not null or ${m.status} = 'active' then 'consumed'
      when ${m.inviteExpiresAt} is not null and ${m.inviteExpiresAt} <= now() then 'expired'
      when ${m.inviteExpiresAt} is null and ${m.invitedAt} + interval '7 days' <= now() then 'expired'
      when ${m.status} = 'pending' then 'pending'
      else 'not_found'
    end)`;
}

/** {@link shownMemberStatus} as SQL (`shown_status` of `list_circle_members`). */
export function shownMemberStatusSql(m: SlotRowRef = MEMBER_SLOT_COLUMNS): SQL {
  return sql`(case
      when ${m.status} = 'pending' and ${inviteLookupStatusSql(m)} = 'expired' then 'expired'
      else ${m.status}
    end)`;
}

/**
 * The Capacity JSON of one circle (`_circle_invite_capacity_json(p_circle_id)`), built by Postgres
 * with the same `jsonb_build_object`, so keys, their order (jsonb order) and integer types are the
 * helper's. `circleId` is a uuid SQL expression. Owner row excluded; declined, canceled and expired
 * rows excluded (rule 8).
 */
export function capacityJsonSql(circleId: SQL): SQL {
  const scm = memberAlias('cap_m');
  return sql`(
    select jsonb_build_object(
             'limit', ${CIRCLE_MEMBER_LIMIT}::integer,
             'active_count', counts.active_count,
             'pending_count', counts.pending_count,
             'used', counts.active_count + counts.pending_count,
             'available', greatest(
               0,
               ${CIRCLE_MEMBER_LIMIT}::integer - (counts.active_count + counts.pending_count)
             )
           )
      from (
        select count(*) filter (
                 where cap_m.role = 'member' and cap_m.status = 'active'
               )::integer as active_count,
               count(*) filter (
                 where cap_m.role = 'member'
                   and cap_m.status = 'pending'
                   and ${holdsSlotSql(scm)}
               )::integer as pending_count
          from public.safety_circle_members cap_m
         where cap_m.circle_id = ${circleId}
      ) counts
  )`;
}
