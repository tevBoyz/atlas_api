import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import {
  circleActiveMember,
  circleOwner,
  incidentAlias,
  incidentMemberView,
  incidentResident,
} from '../../common/policies';
import type { ApiConfigService } from '../../config';
import type { Database } from '../../db/database.service';
import {
  capacityJsonSql,
  holdsSlotSql,
  memberAlias,
  notEndedSql,
  shownMemberStatusSql,
} from './invite-slots';

/** Anything that runs SQL: the pool, or an open transaction. */
export type CirclesExecutor = Pick<Database, 'execute'>;

/** `safety_circles` as the app reads it (`fetchOwnCircle`, spec §7.8): column order, json text. */
export type SafetyCircleJson = Record<string, unknown> & {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

/** Capacity (spec §7.0), exactly as `_circle_invite_capacity_json` builds it. */
export type CapacityJson = Record<string, unknown> & {
  limit: number;
  active_count: number;
  pending_count: number;
  used: number;
  available: number;
};

/** One element of `list_circle_members` (spec §7.2): 8 keys, or 14 in the owner view. */
export type CircleMemberJson = Record<string, unknown>;

/** One element of `list_my_joined_circles` (spec §7.3), exactly as the SQL builds it. */
export type JoinedCircleJson = Record<string, unknown> & {
  circle_id: string;
  name: string;
  role: 'owner' | 'member';
  member_id: string;
  status: 'active';
  owner_name: string | null;
  joined_at: string;
  active_member_count: number;
  /** SCRUM-81 (D45): the circle's newest `active` incident the caller may open, else null. */
  active_incident_id: string | null;
  /**
   * Gap 20 (D50): slots used in the circle, owner excluded: active members + valid pending
   * invitations (Capacity `used`, rule 8). A count only, never who is pending.
   */
  capacity_used: number;
};

/** Where the caller stands towards a circle (the first checks of `list_circle_members`). */
export interface CircleAccessRow extends Record<string, unknown> {
  exists: boolean;
  is_owner: boolean;
  is_active_member: boolean;
}

/** Where public avatar URLs point (spec §11.3 P8 note, API-100-37 AC3; D12: the new project). */
export interface AvatarUrlBase {
  /** `SUPABASE_URL` without trailing slashes; empty when unset (then the URL is a path). */
  origin: string;
  /** Storage bucket, `avatars` by default (`AVATARS_BUCKET`). */
  bucket: string;
}

/** {@link AvatarUrlBase} from config: `SUPABASE_URL` without trailing slashes, `AVATARS_BUCKET`. */
export function avatarUrlBase(config: ApiConfigService): AvatarUrlBase {
  return {
    origin: (config.get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    bucket: config.get('AVATARS_BUCKET'),
  };
}

/**
 * The public avatar URL of `avatarPath` (a `profiles.avatar_path` expression), built by Postgres
 * exactly as `_avatars_public_url(object_path)` (baseline migration 20261019140000):
 * `nullif(trim(coalesce(path, '')), '')` (spaces only, as Postgres `trim`) → null; a value that
 * already is an `http(s)://` URL (any case) → as is; else `{origin}/storage/v1/object/public/{bucket}/{path}`.
 * The SQL takes the origin from the request's Host header (`https://` + host without port), or
 * returns the bare path when there is none; the API takes it from config (`SUPABASE_URL`, which is
 * that host on the hosted project), and returns the bare path when `SUPABASE_URL` is unset.
 */
export function avatarUrlSql(avatarPath: SQL, base: AvatarUrlBase): SQL {
  const raw = sql`nullif(trim(coalesce(${avatarPath}, '')), '')`;
  const prefix = `${base.origin}/storage/v1/object/public/${base.bucket}/`;
  return sql`(case
      when ${raw} is null then null
      when ${raw} ~* '^https?://' then ${raw}
      else ${prefix}::text || ${raw}
    end)`;
}

/**
 * `_circle_owner_display_name(circle)` (baseline 20261019130000): the owner row's STORED
 * `display_name`, not the profile name (spec §7.3 `owner_name`). `circleId` is a uuid SQL expression.
 */
export function circleOwnerNameSql(circleId: SQL): SQL {
  return sql`(select om.display_name
                from public.safety_circle_members om
               where om.circle_id = ${circleId}
                 and om.role = 'owner'
               limit 1)`;
}

/**
 * SCRUM-81 (D45): the newest `active` incident of circle `circleId` (a uuid SQL expression) that
 * `callerId` may open (`incident.resident` or `incident.memberView`, the policy of opening it), or
 * null. Reads `incidents` by `incidents_circle_id_idx`.
 */
export function activeIncidentIdSql(circleId: SQL, callerId: string): SQL {
  const incident = incidentAlias('ai_i');
  return sql`(select ai_i.id
                from public.incidents ai_i
               where ai_i.circle_id = ${circleId}
                 and ai_i.status = 'active'
                 and (${incidentResident.where({ callerId, incident })}
                      or ${incidentMemberView.where({ callerId, incident })})
               order by ai_i.activated_at desc nulls last, ai_i.created_at desc, ai_i.id desc
               limit 1)`;
}

/**
 * The SQL of the circle reads (spec §7.2, §7.8): the owned circle, Capacity and the member list.
 * Reads only, no row locks (the SQL functions take none). JSON is built by Postgres exactly as the
 * SQL builds it; the caller's transaction sets `TimeZone` to UTC first, so timestamps are the text
 * PostgREST returns on the hosted project.
 */
@Injectable()
export class CirclesRepository {
  /** Timestamps in JSON as UTC text (`...+00:00`), as the hosted project's sessions write them. */
  async useUtcTimestamps(tx: CirclesExecutor): Promise<void> {
    await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
  }

  /**
   * The caller's own circle (`safety_circles` SELECT `owner_id = uid`, RLS `safety_circles_select_own`
   * = `circle.owner`). `circle` is `json` (not `jsonb`) so its keys keep the table's column order, as
   * PostgREST's `select *` returns them. Undefined when the caller owns no circle.
   */
  async ownedCircle(
    tx: CirclesExecutor,
    callerId: string,
  ): Promise<{ id: string; circle: SafetyCircleJson } | undefined> {
    const result = await tx.execute<{ id: string; circle: SafetyCircleJson }>(sql`
      select c.id::text as id,
             json_build_object(
               'id', c.id,
               'owner_id', c.owner_id,
               'name', c.name,
               'created_at', c.created_at,
               'updated_at', c.updated_at
             ) as circle
        from public.safety_circles c
       where c.owner_id = ${callerId}::uuid`);
    return result.rows[0];
  }

  /** Capacity of a circle (`_circle_invite_capacity_json`). */
  async capacity(tx: CirclesExecutor, circleId: string): Promise<CapacityJson> {
    const result = await tx.execute<{ body: CapacityJson }>(
      sql`select ${capacityJsonSql(sql`${circleId}::uuid`)} as body`,
    );
    return result.rows[0].body;
  }

  /**
   * The checks of `list_circle_members` in one statement: does the circle exist, is the caller its
   * owner (`circle.owner`), is the caller an active member (`circle.activeMember`, owner row
   * included).
   */
  async access(tx: CirclesExecutor, circleId: string, callerId: string): Promise<CircleAccessRow> {
    const circle = sql`${circleId}::uuid`;
    const result = await tx.execute<CircleAccessRow>(sql`
      select exists (select 1 from public.safety_circles c where c.id = ${circle}) as exists,
             coalesce(${circleOwner.where({ circleId: circle, callerId })}, false) as is_owner,
             coalesce(${circleActiveMember.where({ circleId: circle, callerId })}, false)
               as is_active_member`);
    return result.rows[0];
  }

  /**
   * The rows of `list_circle_members(circle_id)` (final definition: baseline migration
   * 20261117120000) as one jsonb array:
   * - owner view: every row of the circle with 14 keys, except ENDED rows (`removed` / `left`,
   *   D44: history only, never shown); member view: `status = 'active'` rows only, with 8 keys
   *   (never phone, email, relationship, invite timestamps or the token);
   * - `status`: stored status, except a stored `pending` row whose lookup status is `expired` →
   *   `expired` (fix #14);
   * - `display_name`: an `active` row with a `user_id` shows that user's `profiles.full_name`,
   *   trimmed (spaces), when non-empty, else the stored name; every other row the stored name (fix
   *   #18, `_member_profile_name`);
   * - `avatar_url`: from the row user's `profiles.avatar_path` ({@link avatarUrlSql}), null without a
   *   `user_id`, a profile or a path;
   * - order: owner first, then `active` < `pending` < `expired` < `declined`, then `lower(shown
   *   name)` (database collation, as the SQL), then `invited_at`; then `id`, so rows the SQL leaves in
   *   no defined order (same status, name and invite time) come back in a stable order.
   */
  async listMembers(
    tx: CirclesExecutor,
    circleId: string,
    ownerView: boolean,
    avatars: AvatarUrlBase,
  ): Promise<CircleMemberJson[]> {
    const scm = memberAlias('scm');
    const avatarUrl = sql`case
        when r.user_id is not null then ${avatarUrlSql(sql`r.avatar_path`, avatars)}
        else null
      end`;
    const common = sql`'member_id', r.id,
              'role', r.role,
              'status', r.shown_status,
              'display_name', r.shown_name,
              'is_owner', r.role = 'owner',
              'invited_at', r.invited_at,
              'user_id', r.user_id,
              'avatar_url', ${avatarUrl}`;
    const payload = ownerView
      ? sql`jsonb_build_object(
              ${common},
              'phone', r.phone,
              'email', r.email,
              'relationship', r.relationship,
              'invite_expires_at', r.invite_expires_at,
              'invite_consumed_at', r.invite_consumed_at,
              'invite_canceled_at', r.invite_canceled_at
            )`
      : sql`jsonb_build_object(${common})`;
    const result = await tx.execute<{ body: CircleMemberJson[] }>(sql`
      select coalesce(
               jsonb_agg(
                 listed.payload
                 order by listed.sort_owner desc, listed.sort_status, listed.display_sort,
                          listed.invited_sort, listed.sort_id
               ),
               '[]'::jsonb
             ) as body
        from (
          select ${payload} as payload,
                 (r.role = 'owner') as sort_owner,
                 case r.shown_status
                   when 'active' then 0
                   when 'pending' then 1
                   when 'expired' then 2
                   when 'declined' then 3
                   else 4
                 end as sort_status,
                 lower(r.shown_name) as display_sort,
                 r.invited_at as invited_sort,
                 r.id as sort_id
            from (
              select scm.id,
                     scm.role,
                     scm.user_id,
                     scm.invited_at,
                     scm.phone,
                     scm.email,
                     scm.relationship,
                     scm.invite_expires_at,
                     scm.invite_consumed_at,
                     scm.invite_canceled_at,
                     p.avatar_path,
                     case
                       when scm.status = 'active' and scm.user_id is not null
                         then coalesce(nullif(trim(p.full_name), ''), scm.display_name)
                       else scm.display_name
                     end as shown_name,
                     ${shownMemberStatusSql(scm)} as shown_status
                from public.safety_circle_members scm
                left join public.profiles p
                  on p.id = scm.user_id
               where scm.circle_id = ${circleId}::uuid
                 and ${notEndedSql(sql`scm.status`)}
                 and (${ownerView}::boolean or scm.status = 'active')
            ) r
        ) listed`);
    return result.rows[0].body;
  }

  /**
   * `list_my_joined_circles()` (final: baseline 20261021140000) as one jsonb array, built by Postgres
   * with the function's `jsonb_build_object` (same keys, key order, types and timestamp text): every
   * `active` member row of the caller (owner rows included: the caller's own circle is listed with
   * `role: owner`, parity; SCRUM-81 changes this later), `joined_at` = the member row's `updated_at`,
   * `active_member_count` = rows of that circle with `role = 'member'` and `status = 'active'`
   * (owner, pending and declined excluded), `owner_name` = the owner row's stored name. Order: the
   * function's `(payload->>'joined_at') desc` (the same expression, so the same order); the SQL
   * leaves equal `joined_at` values in no defined order, the API then orders by `member_id`. No
   * phone, email, emergency or medical field. No lock (the function is `stable`).
   *
   * SCRUM-81 (D45, additive; not in the SQL function): `active_incident_id` = the circle's newest
   * incident with status `active` that the caller may OPEN: `incident.memberView` (the policy of
   * `get_incident_details`: a current `active` member row activated no later than the incident,
   * rule 54, not the resident) or `incident.resident` (the resident's own open alert), else null. So on
   * a `member` row it is an alert the caller received (never one that started before they joined),
   * and on the caller's own `owner` row it is the caller's own active alert (they are its
   * resident). Newest = latest `activated_at`, then `created_at`, then `id` (one label per circle).
   *
   * Gap 20 (D50, additive; not in the SQL function): `capacity_used` = the circle's rows holding a
   * slot ({@link holdsSlotSql}: `active` members + valid pending invitations, owner excluded), the
   * Capacity `used` of `GET /v1/me/circle/capacity`, so the Member View shows "Members (n of 5)" as
   * the owner screen does. A count only.
   */
  async joinedCircles(tx: CirclesExecutor, callerId: string): Promise<JoinedCircleJson[]> {
    const result = await tx.execute<{ body: JoinedCircleJson[] }>(sql`
      select coalesce(
               jsonb_agg(listed.payload
                         order by (listed.payload->>'joined_at') desc, listed.member_id),
               '[]'::jsonb
             ) as body
        from (
          select scm.id as member_id,
                 jsonb_build_object(
                   'circle_id', c.id,
                   'name', c.name,
                   'role', scm.role,
                   'member_id', scm.id,
                   'status', scm.status,
                   'owner_name', ${circleOwnerNameSql(sql`c.id`)},
                   'joined_at', scm.updated_at,
                   'active_member_count', (
                     select count(*)::integer
                       from public.safety_circle_members active_members
                      where active_members.circle_id = c.id
                        and active_members.role = 'member'
                        and active_members.status = 'active'
                   ),
                   'active_incident_id', ${activeIncidentIdSql(sql`c.id`, callerId)},
                   'capacity_used', (
                     select count(*)::integer
                       from public.safety_circle_members cap_u
                      where cap_u.circle_id = c.id
                        and ${holdsSlotSql(memberAlias('cap_u'))}
                   )
                 ) as payload
            from public.safety_circle_members scm
            join public.safety_circles c on c.id = scm.circle_id
           where scm.user_id = ${callerId}::uuid
             and scm.status = 'active'
        ) listed`);
    return result.rows[0].body;
  }
}
