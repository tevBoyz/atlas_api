import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { incidentAlias, incidentMemberView } from '../common/policies';
import { DatabaseService } from '../db/database.service';

/**
 * What a broadcast needs about one incident, read after the write committed (API-100-41). Built by
 * Postgres in UTC, so timestamps have the same text as the REST bodies.
 */
export interface IncidentBroadcastState {
  incident_id: string;
  resident_id: string;
  circle_id: string | null;
  /**
   * The 16 keys the app merges today from `postgres_changes` (spec §9) plus
   * `location_sharing_ended_at` (spec §11.5); never `resident_id` / `circle_id`. `share_payload` is
   * the live view (`live_share_payload`, SCRUM-21 D53) else the activation snapshot, `{}` when
   * null, as in the REST incident details.
   */
  incident: Record<string, unknown>;
  status: string;
  emergency_type: string;
  activated_at: string;
  sent_at: string | null;
  renotified_at: string | null;
  resolved_at: string | null;
  resolved_reason: string | null;
  location_sharing_ended_at: string | null;
  location_source: string | null;
  location_lat: number | string | null;
  location_lng: number | string | null;
  location_accuracy_m: number | string | null;
  location_captured_at: string | null;
  incident_notes: string | null;
  incident_notes_updated_at: string | null;
  /** `incidents.updated_at`: database time of the last write of the row. */
  updated_at: string;
  /** Database time of this read (`statement_timestamp()`): later reads see newer or equal state. */
  occurred_at: string;
  /** `coalesce(profiles.full_name, '')`, as the responder list and details. */
  resident_name: string;
  delivered_count: number;
  acknowledged_count: number;
}

/** One `incident_events` row, as `GET /v1/incidents/{id}/events` returns it to the resident. */
export interface IncidentEventRow {
  incident_id: string;
  resident_id: string;
  event: {
    id: string;
    event_type: string;
    occurred_at: string;
    actor_id: string | null;
    detail: Record<string, unknown>;
  };
}

/** The 16 merged keys, in the order of spec §11.5. */
const INCIDENT_UPDATED_JSON = sql`jsonb_build_object(
    'emergency_type', rec.emergency_type,
    'status', rec.status,
    'sent_at', rec.sent_at,
    'renotified_at', rec.renotified_at,
    'resolved_at', rec.resolved_at,
    'resolved_reason', rec.resolved_reason,
    'auto_closed', rec.auto_closed,
    'location_lat', rec.location_lat,
    'location_lng', rec.location_lng,
    'location_accuracy_m', rec.location_accuracy_m,
    'location_captured_at', rec.location_captured_at,
    'location_source', rec.location_source,
    'location_sharing_ended_at', rec.location_sharing_ended_at,
    'incident_notes', rec.incident_notes,
    'incident_notes_updated_at', rec.incident_notes_updated_at,
    'share_payload', coalesce(rec.live_share_payload, rec.share_payload, '{}'::jsonb)
  )`;

/** `incident.shared_info_updated` (SCRUM-21, D53): the live shared info of one incident. */
export interface IncidentSharedInfoState {
  incident_id: string;
  /** `live_share_payload` (else the activation `share_payload`, else `{}`), as the member read. */
  share_payload: Record<string, unknown>;
  /** `live_share_updated_at`: when the live view last changed. */
  updated_at: string | null;
  /** Database time of this read (`statement_timestamp()`). */
  occurred_at: string;
}

/**
 * The post-commit reads of the realtime broadcasts (API-100-41, API-100-42). Each runs in its own
 * read-only transaction in UTC on the pool; it never holds a lock and never runs inside the write.
 */
@Injectable()
export class RealtimeReadsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** The incident's broadcast state; undefined when the row is gone. */
  async incidentState(incidentId: string): Promise<IncidentBroadcastState | undefined> {
    return this.readOne<IncidentBroadcastState>(sql`
      select jsonb_build_object(
               'incident_id', rec.id,
               'resident_id', rec.resident_id,
               'circle_id', rec.circle_id,
               'incident', ${INCIDENT_UPDATED_JSON},
               'status', rec.status,
               'emergency_type', rec.emergency_type,
               'activated_at', rec.activated_at,
               'sent_at', rec.sent_at,
               'renotified_at', rec.renotified_at,
               'resolved_at', rec.resolved_at,
               'resolved_reason', rec.resolved_reason,
               'location_sharing_ended_at', rec.location_sharing_ended_at,
               'location_source', rec.location_source,
               'location_lat', rec.location_lat,
               'location_lng', rec.location_lng,
               'location_accuracy_m', rec.location_accuracy_m,
               'location_captured_at', rec.location_captured_at,
               'incident_notes', rec.incident_notes,
               'incident_notes_updated_at', rec.incident_notes_updated_at,
               'updated_at', rec.updated_at,
               'occurred_at', statement_timestamp(),
               'resident_name', coalesce(p.full_name, ''),
               'delivered_count', c.delivered_count,
               'acknowledged_count', c.acknowledged_count
             ) as body
        from public.incidents rec
        left join public.profiles p
          on p.id = rec.resident_id
       cross join lateral (
         select count(*)::int as delivered_count,
                count(*) filter (where d.acknowledged_at is not null)::int as acknowledged_count
           from public.incident_deliveries d
          where d.incident_id = rec.id
       ) c
       where rec.id = ${incidentId}::uuid`);
  }

  /** The live shared info of an incident (D53); undefined when the row is gone. */
  async sharedInfo(incidentId: string): Promise<IncidentSharedInfoState | undefined> {
    return this.readOne<IncidentSharedInfoState>(sql`
      select jsonb_build_object(
               'incident_id', rec.id,
               'share_payload', coalesce(rec.live_share_payload, rec.share_payload, '{}'::jsonb),
               'updated_at', rec.live_share_updated_at,
               'occurred_at', statement_timestamp()
             ) as body
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
  }

  /**
   * The users of the incident's delivery rows (D14: the rows the submit or re-notify actually wrote)
   * who pass `incident.memberView` now (an active member row inside the window, not the resident).
   * A member removed or gone since the write is not a recipient any more. Sorted.
   */
  async recipientUserIds(incidentId: string): Promise<string[]> {
    const memberView: SQL = incidentMemberView.where({
      callerId: sql`d.member_user_id`,
      incident: incidentAlias('rec'),
    });
    const body = await this.readOne<string[]>(sql`
      select coalesce(jsonb_agg(d.member_user_id order by d.member_user_id), '[]'::jsonb) as body
        from public.incident_deliveries d
        join public.incidents rec
          on rec.id = d.incident_id
       where d.incident_id = ${incidentId}::uuid
         and ${memberView}`);
    return body ?? [];
  }

  /** One event row with its incident's resident; undefined when gone. */
  async event(eventId: string): Promise<IncidentEventRow | undefined> {
    return this.readOne<IncidentEventRow>(sql`
      select jsonb_build_object(
               'incident_id', e.incident_id,
               'resident_id', rec.resident_id,
               'event', jsonb_build_object(
                 'id', e.id,
                 'event_type', e.event_type,
                 'occurred_at', e.occurred_at,
                 'actor_id', e.actor_id,
                 'detail', e.detail
               )
             ) as body
        from public.incident_events e
        join public.incidents rec
          on rec.id = e.incident_id
       where e.id = ${eventId}::uuid`);
  }

  private async readOne<T>(query: SQL): Promise<T | undefined> {
    return this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        const result = await tx.execute<{ body: T }>(query);
        return result.rows[0]?.body;
      },
      { accessMode: 'read only' },
    );
  }
}
