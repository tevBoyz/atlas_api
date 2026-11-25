import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { incidentAlias, incidentMemberView } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import { eventActorNameSql } from '../incidents/incident-events.service';
import {
  ACTIVITY_DEFAULT_LIMIT,
  type ActivityCategory,
  type ActivityQuery,
  decodeActivityCursor,
  encodeActivityCursor,
} from './activity.schemas';

/** One page of `GET /v1/me/activity`. */
export interface ActivityPage {
  entries: Record<string, unknown>[];
  next_cursor: string | null;
}

type ActivityRow = {
  entry: Record<string, unknown>;
  cursor_at: string;
  cursor_id: string;
};

/**
 * True when the alert of the event aliased `e` has a `safe_recorded` event. Used so an alert has ONE `ended` entry: `safe_recorded` (marked safe) when there is one, else
 * `incident_closed` (the automatic close; or a legacy close without a safe record).
 */
const hasSafeRecorded = sql`exists (
  select 1 from public.incident_events s
   where s.incident_id = e.incident_id and s.event_type = 'safe_recorded')`;

/**
 * SCRUM-82 (View Emergency Activity Log), D72: the caller's activity log, built from
 * `incident_events`, newest first, paged by a cursor on (`occurred_at`, `id`). Read-only, in UTC.
 *
 * - **mine** (My Emergencies): events of alerts the caller raised (`incident.resident`; status
 *   active / resolved / closed, legacy statuses left out as in the recent-alerts list):
 *   `alert_sent` → `emergency_initiated`, `location_sharing_started` → `location_shared`, every
 *   member's `responder_acknowledged` / `responder_status` → `acknowledged` / `responding` /
 *   `unable`, and one `ended`.
 * - **circle** (Circle Alerts): events of alerts the caller passes `incident.memberView` for (an
 *   ACTIVE member of the alert's circle since before it started, not the resident; removed / left
 *   = nothing, P1): `alert_sent` → `alert_received`, the CALLER'S OWN acknowledged / responding /
 *   unable, the resident's `status_update`s, and one `ended`.
 * - Never shown: `renotified`, `location_sharing_ended`, `closure_notified`, `incident_closed` after
 *   a `safe_recorded`, other members' responses on circle alerts.
 *
 * No user id is returned anywhere; names only (D71). `detail` carries only the status update's
 * preset / text and the end reason.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly database: DatabaseService) {}

  async list(user: AuthenticatedUser, query: ActivityQuery): Promise<ActivityPage> {
    const category: ActivityCategory = query.category ?? 'all';
    const limit = query.limit ?? ACTIVITY_DEFAULT_LIMIT;
    const cursor = query.before === undefined ? undefined : decodeActivityCursor(query.before);
    if (query.before !== undefined && !cursor) {
      throw new DomainError('validation:invalid_request', { details: { field: 'before' } });
    }
    const rows = await this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        const result = await tx.execute<ActivityRow>(
          this.statement(
            user.id,
            category,
            limit + 1,
            cursor &&
              sql`
            and (e.occurred_at, e.id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`,
          ),
        );
        return result.rows;
      },
      { accessMode: 'read only' },
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => row.entry),
      next_cursor:
        rows.length > limit && last
          ? encodeActivityCursor({ occurredAt: last.cursor_at, id: last.cursor_id })
          : null,
    };
  }

  private statement(
    callerId: string,
    category: ActivityCategory,
    take: number,
    after: SQL | undefined,
  ): SQL {
    const caller = sql`${callerId}::uuid`;
    const parts: SQL[] = [];
    if (category !== 'circle') {
      parts.push(sql`
        select i.id, i.resident_id, i.circle_id, i.status, i.emergency_type, 'mine'::text as category
          from public.incidents i
         where i.resident_id = ${caller}
           and i.status in ('active', 'resolved', 'closed')`);
    }
    if (category !== 'mine') {
      // The membership pre-filter only narrows the scan; the policy is the rule.
      parts.push(sql`
        select i.id, i.resident_id, i.circle_id, i.status, i.emergency_type, 'circle'::text as category
          from public.incidents i
         where i.circle_id in (
                 select m.circle_id from public.safety_circle_members m
                  where m.user_id = ${caller} and m.status = 'active')
           and ${incidentMemberView.where({ callerId, incident: incidentAlias('i') })}`);
    }
    const visible = sql.join(parts, sql` union all `);
    const responseStatus = sql`e.detail ->> 'status' in ('responding', 'unable')`;
    const endedReason = sql`case
        when e.event_type = 'safe_recorded' then 'safe'
        when coalesce(e.detail ->> 'reason', e.detail ->> 'resolved_reason') = 'safe' then 'safe'
        else 'ended'
      end`;
    return sql`
      select jsonb_build_object(
               'id', e.id,
               'kind', case e.event_type
                         when 'alert_sent' then
                           case v.category when 'mine' then 'emergency_initiated' else 'alert_received' end
                         when 'location_sharing_started' then 'location_shared'
                         when 'responder_acknowledged' then 'acknowledged'
                         when 'responder_status' then e.detail ->> 'status'
                         when 'status_update' then 'status_update'
                         else 'ended'
                       end,
               'category', v.category,
               'occurred_at', e.occurred_at,
               'incident', jsonb_build_object(
                 'id', v.id,
                 'status', v.status,
                 'emergency_type', v.emergency_type,
                 'resident_name', case when v.category = 'circle'
                                    then coalesce(trim(p.full_name), '') end,
                 'circle_name', case when v.category = 'circle' then c.name end
               ),
               'actor_name', ${eventActorNameSql('e', 'v')},
               'detail', case
                           when e.event_type = 'status_update' then jsonb_build_object(
                             'preset', e.detail ->> 'preset', 'text', e.detail ->> 'text')
                           when e.event_type in ('safe_recorded', 'incident_closed') then
                             jsonb_build_object('reason', ${endedReason})
                         end
             ) as entry,
             to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
             e.id::text as cursor_id
        from (${visible}) v
        join public.incident_events e on e.incident_id = v.id
        left join public.profiles p on p.id = v.resident_id
        left join public.safety_circles c on c.id = v.circle_id
       where (
               (v.category = 'mine' and (
                  e.event_type in ('alert_sent', 'location_sharing_started',
                                   'responder_acknowledged', 'safe_recorded')
                  or (e.event_type = 'responder_status' and ${responseStatus})
                  or (e.event_type = 'incident_closed' and not ${hasSafeRecorded})))
               or (v.category = 'circle' and (
                  e.event_type in ('alert_sent', 'status_update', 'safe_recorded')
                  or (e.event_type = 'responder_acknowledged' and e.actor_id = ${caller})
                  or (e.event_type = 'responder_status' and e.actor_id = ${caller}
                      and ${responseStatus})
                  or (e.event_type = 'incident_closed' and not ${hasSafeRecorded})))
             )
             ${after ?? sql``}
       order by e.occurred_at desc, e.id desc
       limit ${take}`;
  }
}
