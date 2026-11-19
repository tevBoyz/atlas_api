import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { circleActiveMember, circleOwner } from '../../common/policies';
import type { Database } from '../../db/database.service';
import { capacityJsonSql, memberAlias, shownMemberStatusSql } from './invite-slots';

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
   * - owner view: every row of the circle with 14 keys; member view: `status = 'active'` rows only,
   *   with 8 keys (never phone, email, relationship, invite timestamps or the token);
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
                 and (${ownerView}::boolean or scm.status = 'active')
            ) r
        ) listed`);
    return result.rows[0].body;
  }
}
