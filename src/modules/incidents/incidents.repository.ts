import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { incidentAlias, incidentResident } from '../../common/policies';
import type { Database } from '../../db';
import { IncidentEventService } from './incident-events.service';
import { INCIDENT_SEND_JSON, INCIDENT_SHARED_JSON } from './incident-json';
import type { SubmitOutcome, SubmittableEmergencyType } from './incident.schemas';

/** The open transaction of a submit. */
export type IncidentTransaction = Pick<Database, 'execute'>;

export interface OpenIncidentRow extends Record<string, unknown> {
  id: string;
  status: string;
}

/** The caller's own incident, locked `FOR UPDATE`. */
export interface LockedIncidentRow extends Record<string, unknown> {
  id: string;
  status: string;
  /** `resolved_reason` (`safe` on an incident closed by mark safe). */
  resolved_reason: string | null;
  /** `location_sharing_ended_at is not null`. */
  sharing_ended: boolean;
}

/** The lifecycle events `mark_incident_safe` writes, in the order it writes them (spec §5.6). */
export const CLOSURE_EVENT_TYPES = [
  'safe_recorded',
  'incident_closed',
  'location_sharing_ended',
  'closure_notified',
] as const;

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
 * The SQL statements of `submit_emergency_alert` (final definition: baseline migration
 * 20261023150000), one method per step, in the order the function runs them. Every method takes the
 * caller's transaction, so all of a submit commits or rolls back together. Also the resident reads
 * `get_my_open_incident` and `list_my_recent_incidents`, and the statements `set_incident_notes`,
 * `renotify_emergency_alert` and `attach_incident_location` share with them (row lock, JSON shapes).
 *
 * JSON is built by Postgres, as the SQL function does, so timestamps keep their microseconds and
 * format. Medical values stay inside these statements except for the response body itself.
 */
@Injectable()
export class IncidentsRepository {
  /** Every event goes through the one event writer (API-100-22). */
  constructor(private readonly events: IncidentEventService) {}

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

  /**
   * One row per active member with an account, never the resident and never a pending invite.
   *
   * D14 ("an SOS must always go through", 2026-11-20): the member rows are read `FOR KEY SHARE` in
   * the same statement, before the insert. That is the lock the foreign key check
   * (`incident_deliveries_member_id_fkey`) takes anyway, only taken earlier. A member who leaves or is
   * removed concurrently is then either deleted before the read (the read waits for that delete to
   * commit and skips the row: that member is simply not notified) or kept until this submit commits
   * (the delete waits, then cascades the new delivery). The SQL function reads the rows without a
   * lock, so a delete committing between its read and its foreign key check fails the whole submit
   * with 23503; this statement cannot. Everything else (rows, events, counts, response) is unchanged.
   */
  async insertDeliveries(
    tx: IncidentTransaction,
    incidentId: string,
    circleId: string,
    residentId: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.incident_deliveries (incident_id, member_id, member_user_id)
      select ${incidentId}::uuid, r.id, r.user_id
        from (
          select m.id, m.user_id
            from public.safety_circle_members m
           where m.circle_id = ${circleId}::uuid
             and m.status = 'active'
             and m.user_id is not null
             and m.user_id is distinct from ${residentId}::uuid
             for key share of m
        ) as r
      on conflict (incident_id, member_user_id) do nothing`);
  }

  async recordAlertSent(
    tx: IncidentTransaction,
    incidentId: string,
    actorId: string,
  ): Promise<void> {
    await this.events.record(
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
    await this.events.record(tx, incidentId, 'location_sharing_started', actorId, sql`'{}'::jsonb`);
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

    await this.events.record(
      tx,
      incidentId,
      'renotified',
      actorId,
      sql`jsonb_build_object('recipient_count', ${refreshed}::int)`,
    );
    return refreshed;
  }

  /**
   * The first step of `attach_incident_location`, `set_incident_notes` and `renotify_emergency_alert`:
   * `select * from incidents where id = $1 and resident_id = uid for update`. Undefined when the id is
   * unknown or not the caller's (both are `not_found`). `incidentId` must already be valid uuid input.
   */
  async lockOwnIncident(
    tx: IncidentTransaction,
    incidentId: string,
    residentId: string,
  ): Promise<LockedIncidentRow | undefined> {
    const result = await tx.execute<LockedIncidentRow>(sql`
      select rec.id::text as id,
             rec.status,
             rec.resolved_reason,
             rec.location_sharing_ended_at is not null as sharing_ended
        from public.incidents rec
       where rec.id = ${incidentId}::uuid
         and ${incidentResident.where({ callerId: residentId, incident: incidentAlias('rec') })}
       for update`);
    return result.rows[0];
  }

  /**
   * `FOR KEY SHARE` on the caller's profile: the lock the `incident_events` insert (FK `actor_id` →
   * profiles) takes anyway, taken before the incident row lock. Submit locks the profile `FOR UPDATE`
   * and then the incident; without this, an explicit re-notify or a mark safe holding the incident
   * and waiting for the profile deadlocks with it (the SQL functions do: 40P01). Changes no result,
   * only the order.
   */
  async keyShareProfile(tx: IncidentTransaction, residentId: string): Promise<void> {
    await tx.execute(sql`
      select 1 from public.profiles p where p.id = ${residentId}::uuid for key share`);
  }

  /** `_incident_send_json(rec)` of one incident (IncidentSend). */
  async sendResult(tx: IncidentTransaction, incidentId: string): Promise<Record<string, unknown>> {
    const result = await tx.execute<{ body: Record<string, unknown> }>(sql`
      select ${INCIDENT_SEND_JSON} as body
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
    return result.rows[0].body;
  }

  /** `_incident_activation_json(rec)` of one incident (IncidentShared). */
  async sharedResult(
    tx: IncidentTransaction,
    incidentId: string,
  ): Promise<Record<string, unknown>> {
    const result = await tx.execute<{ body: Record<string, unknown> }>(sql`
      select ${INCIDENT_SHARED_JSON} as body
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
    return result.rows[0].body;
  }

  /**
   * The write of `set_incident_notes` (final definition: baseline migration 20261020150000), after the
   * row lock and the status check: `v := nullif(btrim(coalesce(p, '')), '')`, `too_long` when
   * `char_length(v) > 250`, else store `v` and stamp `incident_notes_updated_at = now()` (also when
   * clearing). Trimming and counting run in Postgres: `btrim` removes spaces only and `char_length`
   * counts code points, neither of which JavaScript's `trim()` / `length` match. Returns undefined
   * (nothing written) when the trimmed note is too long.
   */
  async setNotes(
    tx: IncidentTransaction,
    incidentId: string,
    notes: string | null,
  ): Promise<{ body: Record<string, unknown>; cleared: boolean } | undefined> {
    const result = await tx.execute<{ body: Record<string, unknown>; cleared: boolean }>(sql`
      update public.incidents as rec
         set incident_notes = n.notes,
             incident_notes_updated_at = now()
        from (select nullif(btrim(coalesce(${notes}::text, '')), '') as notes) as n
       where rec.id = ${incidentId}::uuid
         and (n.notes is null or char_length(n.notes) <= 250)
      returning ${INCIDENT_SHARED_JSON} as body, n.notes is null as cleared`);
    return result.rows[0];
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

  /**
   * The close of `mark_incident_safe` (final definition: baseline migration 20261023140000), after the
   * row lock and the status checks: `status = 'resolved'`, `resolved_at = now()`,
   * `resolved_reason = 'safe'`, `auto_closed = false`, `location_sharing_ended_at = now()`. Undefined
   * (nothing written) when the incident is no longer `active`; the caller holds the row lock, so this
   * only guards against a caller that skipped the check.
   */
  async closeSafe(
    tx: IncidentTransaction,
    incidentId: string,
  ): Promise<{ circle_id: string | null } | undefined> {
    const result = await tx.execute<{ circle_id: string | null }>(sql`
      update public.incidents
         set status = 'resolved',
             resolved_at = now(),
             resolved_reason = 'safe',
             auto_closed = false,
             location_sharing_ended_at = now()
       where id = ${incidentId}::uuid
         and status = 'active'
      returning circle_id::text as circle_id`);
    return result.rows[0];
  }

  /**
   * `_incident_active_recipient_ids(rec)` (final definition: baseline migration 20261117100000): the
   * user ids of the incident circle's active members, excluding the resident, whose membership
   * `activated_at` is at or before the incident's `activated_at` (rule 54), ascending (uuid order,
   * sorted by Postgres). Empty when the incident has no circle.
   */
  async closureRecipientIds(tx: IncidentTransaction, incidentId: string): Promise<string[]> {
    const result = await tx.execute<{ ids: string[] }>(sql`
      select coalesce(
               array_agg(m.user_id::text order by m.user_id),
               '{}'::text[]
             ) as ids
        from public.incidents rec
        join public.safety_circle_members m
          on rec.circle_id is not null
         and m.circle_id = rec.circle_id
       where rec.id = ${incidentId}::uuid
         and m.status = 'active'
         and m.user_id is not null
         and m.user_id is distinct from rec.resident_id
         and m.activated_at is not null
         and m.activated_at <= rec.activated_at`);
    return result.rows[0]?.ids ?? [];
  }

  /**
   * The four events of `mark_incident_safe`, in its order: `safe_recorded {}`,
   * `incident_closed {resolved_reason: "safe"}`, `location_sharing_ended {}` and
   * `closure_notified {recipient_count, recipient_ids}`. Each is once-only (a repeat is a no-op).
   * `recipientIds` is {@link closureRecipientIds}: the detail is built from that one read, so the count
   * and the ids always agree.
   */
  async recordClosureEvents(
    tx: IncidentTransaction,
    incidentId: string,
    actorId: string,
    recipientIds: readonly string[],
  ): Promise<void> {
    await this.events.record(tx, incidentId, 'safe_recorded', actorId, sql`'{}'::jsonb`);
    await this.events.record(
      tx,
      incidentId,
      'incident_closed',
      actorId,
      sql`jsonb_build_object('resolved_reason', 'safe')`,
    );
    await this.events.record(tx, incidentId, 'location_sharing_ended', actorId, sql`'{}'::jsonb`);
    await this.events.record(
      tx,
      incidentId,
      'closure_notified',
      actorId,
      sql`jsonb_build_object(
            'recipient_count', ${recipientIds.length}::int,
            'recipient_ids', ${JSON.stringify(recipientIds)}::jsonb
          )`,
    );
  }
}
