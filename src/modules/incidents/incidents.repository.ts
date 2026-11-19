import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { incidentAlias, incidentResident } from '../../common/policies';
import type { Database } from '../../db';
import type { SubmitOutcome, SubmittableEmergencyType } from './incident.schemas';

/** The open transaction of a submit. */
export type IncidentTransaction = Pick<Database, 'execute'>;

export interface OpenIncidentRow extends Record<string, unknown> {
  id: string;
  status: string;
}

export interface WrittenIncidentRow extends Record<string, unknown> {
  id: string;
  circle_id: string | null;
}

/**
 * `_incident_share_payload` for the profile aliased `p` (spec rules 31-32). Built in SQL on purpose:
 * `btrim` removes spaces only (a tab-only value is kept), which `String.prototype.trim` would not match.
 */
const SHARE_PAYLOAD = sql`coalesce(
  jsonb_strip_nulls(
    jsonb_build_object(
      'emergency_contact_full_name',
        case when p.share_emergency_contact_full_name
             then nullif(btrim(p.emergency_contact_full_name), '') end,
      'emergency_contact_relationship',
        case when p.share_emergency_contact_relationship
             then nullif(btrim(p.emergency_contact_relationship), '') end,
      'emergency_contact_phone',
        case when p.share_emergency_contact_phone
             then nullif(btrim(p.emergency_contact_phone), '') end,
      'emergency_contact_email',
        case when p.share_emergency_contact_email
             then nullif(btrim(p.emergency_contact_email), '') end,
      'blood_type',
        case when p.share_blood_type then nullif(btrim(p.blood_type), '') end,
      'allergies',
        case when p.share_allergies then nullif(btrim(p.allergies), '') end,
      'medical_conditions',
        case when p.share_medical_conditions then nullif(btrim(p.medical_conditions), '') end,
      'emergency_preferred_language',
        case when p.share_emergency_preferred_language
             then nullif(btrim(p.emergency_preferred_language), '') end,
      'emergency_notes',
        case when p.emergency_notes_shareable then nullif(btrim(p.emergency_notes), '') end
    )
  ),
  '{}'::jsonb
)`;

/**
 * `_incident_send_json(rec)` for the incident aliased `rec`: IncidentShared (`_incident_activation_json`,
 * 22 keys) plus `delivered_count` and `acknowledged_count`. Submit and the open-incident read both use
 * it, so their bodies are the same bytes for the same row (microsecond timestamps, jsonb key order).
 */
const INCIDENT_SEND_JSON = sql`(
  jsonb_build_object(
    'id', rec.id,
    'resident_id', rec.resident_id,
    'circle_id', rec.circle_id,
    'status', rec.status,
    'activated_at', rec.activated_at,
    'emergency_type', rec.emergency_type,
    'location_lat', rec.location_lat,
    'location_lng', rec.location_lng,
    'location_accuracy_m', rec.location_accuracy_m,
    'location_captured_at', rec.location_captured_at,
    'location_source', rec.location_source,
    'cancelled_at', rec.cancelled_at,
    'sent_at', rec.sent_at,
    'share_payload', rec.share_payload,
    'incident_notes', rec.incident_notes,
    'incident_notes_updated_at', rec.incident_notes_updated_at,
    'renotified_at', rec.renotified_at,
    'resolved_at', rec.resolved_at,
    'resolved_reason', rec.resolved_reason,
    'auto_closed', rec.auto_closed,
    'activity_confirmed_at', rec.activity_confirmed_at,
    'location_sharing_ended_at', rec.location_sharing_ended_at
  )
  || jsonb_build_object(
    'delivered_count', (
      select count(*)::int
        from public.incident_deliveries d
       where d.incident_id = rec.id
    ),
    'acknowledged_count', (
      select count(*)::int
        from public.incident_deliveries d
       where d.incident_id = rec.id
         and d.acknowledged_at is not null
    )
  )
)`;

/**
 * The SQL statements of `submit_emergency_alert` (final definition: baseline migration
 * 20261023150000), one method per step, in the order the function runs them. Every method takes the
 * caller's transaction, so all of a submit commits or rolls back together. Also the resident reads
 * `get_my_open_incident` and `list_my_recent_incidents`.
 *
 * JSON is built by Postgres, as the SQL function does, so timestamps keep their microseconds and
 * format. Medical values stay inside these statements except for the response body itself.
 */
@Injectable()
export class IncidentsRepository {
  /** Timestamps in the response use the UTC offset whatever the server default is. */
  async useUtcTimestamps(tx: IncidentTransaction): Promise<void> {
    await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
  }

  /** Serializes concurrent submits of one resident. Undefined when there is no profile. */
  async lockProfile(
    tx: IncidentTransaction,
    residentId: string,
  ): Promise<{ setup_complete: boolean } | undefined> {
    const result = await tx.execute<{ setup_complete: boolean }>(sql`
      select p.profile_setup_completed_at is not null as setup_complete
        from public.profiles p
       where p.id = ${residentId}::uuid
       for update`);
    return result.rows[0];
  }

  async lockOpenIncident(
    tx: IncidentTransaction,
    residentId: string,
  ): Promise<OpenIncidentRow | undefined> {
    const result = await tx.execute<OpenIncidentRow>(sql`
      select i.id, i.status
        from public.incidents i
       where i.resident_id = ${residentId}::uuid
         and i.status in ('activating', 'active')
       for update`);
    return result.rows[0];
  }

  /** The open incident after a lost insert race. */
  async lockActiveIncident(
    tx: IncidentTransaction,
    residentId: string,
  ): Promise<OpenIncidentRow | undefined> {
    const result = await tx.execute<OpenIncidentRow>(sql`
      select i.id, i.status
        from public.incidents i
       where i.resident_id = ${residentId}::uuid
         and i.status = 'active'
       for update`);
    return result.rows[0];
  }

  /** Legacy `activating` row: `activated_at` and `circle_id` are kept. */
  async promoteIncident(
    tx: IncidentTransaction,
    incidentId: string,
    emergencyType: SubmittableEmergencyType,
  ): Promise<WrittenIncidentRow> {
    const result = await tx.execute<WrittenIncidentRow>(sql`
      update public.incidents i
         set status = 'active',
             emergency_type = ${emergencyType}::text,
             sent_at = now(),
             share_payload = ${SHARE_PAYLOAD},
             cancelled_at = null
        from public.profiles p
       where i.id = ${incidentId}::uuid
         and p.id = i.resident_id
      returning i.id, i.circle_id`);
    return result.rows[0];
  }

  /** Undefined when the one-open-incident index refused the row (a lost race). */
  async insertActiveIncident(
    tx: IncidentTransaction,
    residentId: string,
    emergencyType: SubmittableEmergencyType,
  ): Promise<WrittenIncidentRow | undefined> {
    const result = await tx.execute<WrittenIncidentRow>(sql`
      insert into public.incidents as i (
        resident_id, circle_id, status, emergency_type, activated_at, sent_at, share_payload
      )
      select p.id,
             (select sc.id from public.safety_circles sc where sc.owner_id = p.id),
             'active',
             ${emergencyType}::text,
             now(),
             now(),
             ${SHARE_PAYLOAD}
        from public.profiles p
       where p.id = ${residentId}::uuid
      on conflict (resident_id) where (status in ('activating', 'active'))
      do nothing
      returning i.id, i.circle_id`);
    return result.rows[0];
  }

  /** One row per active member with an account, never the resident and never a pending invite. */
  async insertDeliveries(
    tx: IncidentTransaction,
    incidentId: string,
    circleId: string,
    residentId: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.incident_deliveries (incident_id, member_id, member_user_id)
      select ${incidentId}::uuid, m.id, m.user_id
        from public.safety_circle_members m
       where m.circle_id = ${circleId}::uuid
         and m.status = 'active'
         and m.user_id is not null
         and m.user_id is distinct from ${residentId}::uuid
      on conflict (incident_id, member_user_id) do nothing`);
  }

  async recordAlertSent(
    tx: IncidentTransaction,
    incidentId: string,
    actorId: string,
  ): Promise<void> {
    await this.recordEvent(
      tx,
      incidentId,
      'alert_sent',
      actorId,
      sql`(select jsonb_build_object(
                    'recipient_count', coalesce(array_length(r.ids, 1), 0),
                    'recipient_ids', to_jsonb(r.ids),
                    'emergency_type', i.emergency_type
                  )
             from public.incidents i
            cross join lateral (
              select coalesce(array_agg(d.member_user_id order by d.member_user_id),
                              '{}'::uuid[]) as ids
                from public.incident_deliveries d
               where d.incident_id = i.id
            ) r
            where i.id = ${incidentId}::uuid)`,
    );
  }

  async recordLocationSharingStarted(
    tx: IncidentTransaction,
    incidentId: string,
    actorId: string,
  ): Promise<void> {
    await this.recordEvent(tx, incidentId, 'location_sharing_started', actorId, sql`'{}'::jsonb`);
  }

  /**
   * `_incident_apply_renotify`. The caller holds the incident row lock. Returns the number of delivery
   * rows refreshed; undefined when the incident is not active (nothing is written).
   */
  async applyRenotify(
    tx: IncidentTransaction,
    incidentId: string,
    actorId: string,
  ): Promise<number | undefined> {
    const incident = await tx.execute(sql`
      update public.incidents
         set renotified_at = now()
       where id = ${incidentId}::uuid
         and status = 'active'
      returning id`);
    if (incident.rows.length === 0) return undefined;

    const deliveries = await tx.execute(sql`
      update public.incident_deliveries
         set delivered_at = now()
       where incident_id = ${incidentId}::uuid`);
    const refreshed = deliveries.rowCount ?? 0;

    await this.recordEvent(
      tx,
      incidentId,
      'renotified',
      actorId,
      sql`jsonb_build_object('recipient_count', ${refreshed}::int)`,
    );
    return refreshed;
  }

  /** `_incident_send_json` plus `submit_outcome`. */
  async submitResult(
    tx: IncidentTransaction,
    incidentId: string,
    outcome: SubmitOutcome,
  ): Promise<Record<string, unknown>> {
    const result = await tx.execute<{ body: Record<string, unknown> }>(sql`
      select ${INCIDENT_SEND_JSON}
             || jsonb_build_object('submit_outcome', ${outcome}::text) as body
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
    return result.rows[0].body;
  }

  /**
   * `get_my_open_incident` (final definition: baseline migration 20261023160000): the caller's
   * `active` incident as `_incident_send_json`, or null. One statement, so the incident and its counts
   * come from one snapshot.
   */
  async openIncident(
    tx: IncidentTransaction,
    residentId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await tx.execute<{ body: Record<string, unknown> }>(sql`
      select ${INCIDENT_SEND_JSON} as body
        from public.incidents rec
       where ${incidentResident.where({ callerId: residentId, incident: incidentAlias('rec') })}
         and rec.status = 'active'
       order by rec.activated_at desc
       limit 1`);
    return result.rows[0]?.body ?? null;
  }

  /**
   * `list_my_recent_incidents` (final definition: baseline migration 20261023160000): the caller's
   * `active`/`resolved` incidents, newest `activated_at` first then `id` desc. `limit` is already
   * clamped (see `clampRecentIncidentsLimit`).
   */
  async recentIncidents(
    tx: IncidentTransaction,
    residentId: string,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const result = await tx.execute<{ body: Record<string, unknown>[] }>(sql`
      select coalesce(
               jsonb_agg(r.payload order by r.activated_at desc, r.id desc),
               '[]'::jsonb
             ) as body
        from (
          select i.id,
                 i.activated_at,
                 jsonb_build_object(
                   'id', i.id,
                   'emergency_type', i.emergency_type,
                   'status', i.status,
                   'activated_at', i.activated_at,
                   'sent_at', i.sent_at,
                   'resolved_at', i.resolved_at,
                   'resolved_reason', i.resolved_reason
                 ) as payload
            from public.incidents i
           where ${incidentResident.where({ callerId: residentId, incident: incidentAlias('i') })}
             and i.status in ('active', 'resolved')
           order by i.activated_at desc, i.id desc
           limit ${limit}::int
        ) as r`);
    return result.rows[0].body;
  }

  /** `_incident_record_event`: once-only lifecycle types are no-ops on repeat. */
  private async recordEvent(
    tx: IncidentTransaction,
    incidentId: string,
    eventType: 'alert_sent' | 'location_sharing_started' | 'renotified',
    actorId: string,
    detail: SQL,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.incident_events (incident_id, event_type, actor_id, detail)
      values (${incidentId}::uuid, ${eventType}::text, ${actorId}::uuid,
              coalesce(${detail}, '{}'::jsonb))
      on conflict (incident_id, event_type)
        where event_type in (
          'alert_sent',
          'location_sharing_started',
          'location_sharing_ended',
          'safe_recorded',
          'incident_closed',
          'closure_notified'
        )
      do nothing`);
  }
}
