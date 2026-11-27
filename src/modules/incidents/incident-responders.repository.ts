import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import {
  incidentAlias,
  incidentEventsHistoryView,
  incidentMemberView,
  incidentResident,
} from '../../common/policies';
import { type AvatarUrlBase, avatarUrlSql } from '../circles/circles.repository';
import { type MemberDelivery, memberDeliverySql } from './incident-delivery-status';
import type { IncidentTransaction } from './incidents.repository';

/** What a notified member can answer (SCRUM-50 / 51, D56). */
export const RESPONSE_STATUSES = ['responding', 'unable'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/** A responder row's status: the response, else acknowledged, else no response (D56). */
export const RESPONDER_STATUSES = ['responding', 'acknowledged', 'unable', 'no_response'] as const;
export type ResponderStatus = (typeof RESPONDER_STATUSES)[number];

/**
 * One responder as stored (the user id in full). {@link responderView} turns it into what one caller
 * may see (`user_id` masked for members, `is_me`).
 */
export interface ResponderRow extends Record<string, unknown>, MemberDelivery {
  /** Internal only (routing, `is_me`): never sent to anyone but that member (D79). */
  user_id: string;
  /** D79: the member's membership row id (`incident_deliveries.member_id`), the row's key. */
  handle: string;
  display_name: string;
  avatar_url: string | null;
  status: ResponderStatus;
  acknowledged_at: string | null;
  status_at: string | null;
}

/** The caller's own delivery row, locked `FOR UPDATE` (first step of the response write). */
export interface LockedResponseRow extends Record<string, unknown> {
  id: string;
  acknowledged: boolean;
  response_status: ResponseStatus | null;
}

/** The incident of a response write, read without a lock, with `incident.memberView` evaluated. */
export interface ResponseIncidentRow extends Record<string, unknown> {
  id: string;
  status: string;
  resident_id: string;
  circle_id: string | null;
  member_view: boolean;
}

/**
 * The responder rows of incident `incidentId` (D56) as ONE jsonb array, built by Postgres (timestamps
 * as the session writes them; callers run it in UTC):
 * - one row per delivery (a notified member) whose user passes `incident.memberView` NOW: an `active`
 *   member of the circle whose membership started at or before the incident (rule 54). A member whose
 *   membership ended (removed / left, D44) or who rejoined later is left out (decision 3 of the plan);
 * - `display_name`: the user's profile name trimmed (spaces) when not empty, else the name stored on
 *   the member row, as the circle member list (fix #18); `avatar_url` as the member list
 *   ({@link avatarUrlSql});
 * - `status`: `response_status` when set, else `acknowledged` when `acknowledged_at` is set, else
 *   `no_response`; `status_at`: `response_at` for a response, `acknowledged_at` for acknowledged,
 *   null for no response;
 * - `delivery_status`, `delivery_at`, `delivery_failed_reason` (SCRUM-65, D73): the member's delivery
 *   status of the alert ({@link memberDeliverySql}); {@link responderView} shows them to the
 *   resident only;
 * - order (SCRUM-58): responding, acknowledged, unable, no response; each oldest `status_at` first,
 *   then `delivered_at`, then the user id (a stable order).
 * `onlyUserId` narrows it to that member's row (zero or one element).
 */
export function responderRowsSql(
  incidentId: SQL,
  avatars: AvatarUrlBase,
  onlyUserId?: string,
): SQL {
  const memberView = incidentMemberView.where({
    callerId: sql`rd.member_user_id`,
    incident: incidentAlias('ri'),
  });
  const narrow = onlyUserId ? sql`and rd.member_user_id = ${onlyUserId}::uuid` : sql``;
  return sql`(
    select coalesce(
             jsonb_agg(
               x.body
               order by x.sort_status, x.sort_at nulls last, x.delivered_at, x.user_id
             ),
             '[]'::jsonb
           )
      from (
        select jsonb_build_object(
                 'user_id', rd.member_user_id,
                 'handle', rd.member_id,
                 'display_name', coalesce(nullif(trim(rp.full_name), ''), rm.display_name, ''),
                 'avatar_url', ${avatarUrlSql(sql`rp.avatar_path`, avatars)},
                 'status', rs.status,
                 'acknowledged_at', rd.acknowledged_at,
                 'status_at', rs.status_at
               ) || ${memberDeliverySql(sql`rd.incident_id`, sql`rd.member_user_id`)} as body,
               case rs.status
                 when 'responding' then 0
                 when 'acknowledged' then 1
                 when 'unable' then 2
                 else 3
               end as sort_status,
               rs.status_at as sort_at,
               rd.delivered_at,
               rd.member_user_id as user_id
          from public.incident_deliveries rd
          join public.incidents ri
            on ri.id = rd.incident_id
          left join public.safety_circle_members rm
            on rm.id = rd.member_id
          left join public.profiles rp
            on rp.id = rd.member_user_id
         cross join lateral (
           select case
                    when rd.response_status is not null then rd.response_status
                    when rd.acknowledged_at is not null then 'acknowledged'
                    else 'no_response'
                  end as status,
                  case
                    when rd.response_status is not null then rd.response_at
                    else rd.acknowledged_at
                  end as status_at
         ) rs
         where rd.incident_id = ${incidentId}
           ${narrow}
           and ${memberView}
      ) x
  )`;
}

/**
 * The statements of the responder status (SCRUM-49/50/51/55, D56): the list read and the member's
 * response write. Access decisions are the API-100-09 policies as SQL predicates.
 */
@Injectable()
export class IncidentRespondersRepository {
  /**
   * `GET /v1/incidents/{id}/responders`: ONE statement. The incident by primary key and
   * `incident.eventsView` (the resident at any status; a member inside the window while it is
   * `active` / `resolved` / `closed`, i.e. `incident.resident` OR `incident.memberView`), whether the caller is
   * the resident, and the rows. Undefined when the incident is unknown or hidden (both `not_found`).
   */
  async visibleResponders(
    db: IncidentTransaction,
    incidentId: string,
    callerId: string,
    avatars: AvatarUrlBase,
  ): Promise<{ is_resident: boolean; rows: ResponderRow[] } | undefined> {
    const incident = incidentAlias('rec');
    const result = await db.execute<{ is_resident: boolean; rows: ResponderRow[] }>(sql`
      select ${incidentResident.where({ callerId, incident })} as is_resident,
             ${responderRowsSql(sql`rec.id`, avatars)} as rows
        from public.incidents rec
       where rec.id = ${incidentId}::uuid
         and ${incidentEventsHistoryView.where({ callerId, incident })}`);
    return result.rows[0];
  }

  /**
   * The caller's own delivery row, locked `FOR UPDATE`: the only exclusive row lock of a response
   * (after the D71 key-share locks on the caller's profile and the incident), the same as
   * acknowledge (so the two serialize on it). Undefined when there is none.
   */
  async lockOwnDelivery(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<LockedResponseRow | undefined> {
    const result = await tx.execute<LockedResponseRow>(sql`
      select d.id::text as id,
             d.acknowledged_at is not null as acknowledged,
             d.response_status
        from public.incident_deliveries d
       where d.incident_id = ${incidentId}::uuid
         and d.member_user_id = ${callerId}::uuid
       for update`);
    return result.rows[0];
  }

  /**
   * The incident of a response, read WITHOUT a lock (as acknowledge reads it), with
   * `incident.memberView` for the caller in the same statement. Undefined when it is gone.
   */
  async responseIncident(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<ResponseIncidentRow | undefined> {
    const result = await tx.execute<ResponseIncidentRow>(sql`
      select rec.id::text as id,
             rec.status,
             rec.resident_id::text as resident_id,
             rec.circle_id::text as circle_id,
             coalesce(${incidentMemberView.where({ callerId, incident: incidentAlias('rec') })},
                      false) as member_view
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
    return result.rows[0];
  }

  /**
   * Sets the response on the (already locked) row: `response_status`, `response_at = now()`, and
   * `acknowledged_at = now()` when it was empty (responding or unable implies having seen it).
   */
  async setResponse(
    tx: IncidentTransaction,
    deliveryId: string,
    status: ResponseStatus,
  ): Promise<void> {
    await tx.execute(sql`
      update public.incident_deliveries
         set response_status = ${status}::text,
             response_at = now(),
             acknowledged_at = coalesce(acknowledged_at, now())
       where id = ${deliveryId}::uuid`);
  }

  /** The caller's own responder row (UTC text expected: the caller sets the session time zone). */
  async ownRow(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
    avatars: AvatarUrlBase,
  ): Promise<ResponderRow | undefined> {
    const result = await tx.execute<{ rows: ResponderRow[] }>(sql`
      select ${responderRowsSql(sql`${incidentId}::uuid`, avatars, callerId)} as rows`);
    return result.rows[0]?.rows[0];
  }
}
