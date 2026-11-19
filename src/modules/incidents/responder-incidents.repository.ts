import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { incidentAlias, incidentMemberView } from '../../common/policies';
import type { IncidentTransaction } from './incidents.repository';

/**
 * The member side of incidents (spec §6.10, §7.4): `list_responder_incidents` and
 * `get_incident_details` (final definitions: baseline migration 20261117100000). Access is the
 * API-100-09 policy `incident.memberView` as a SQL predicate: `circle_id` not null, status
 * `active`/`resolved`, the caller an active member whose membership started at or before the incident
 * (`circle.activeMemberSince`, rule 54), and not the resident. JSON is built by Postgres as the SQL
 * functions build it (the caller's transaction sets `TimeZone` to UTC first).
 *
 * Neither shape carries `resident_id`, `circle_id` or profile data other than `resident_name`
 * (API-100-21 AC3).
 */
@Injectable()
export class ResponderIncidentsRepository {
  /**
   * `list_responder_incidents`: every incident the caller may see as a member, filtered entirely in
   * SQL, ordered `coalesce(resolved_at, sent_at, activated_at) desc, id` (asc), no pagination.
   * `resident_name = coalesce(profiles.full_name, '')`.
   */
  async list(tx: IncidentTransaction, callerId: string): Promise<Record<string, unknown>[]> {
    const result = await tx.execute<{ body: Record<string, unknown>[] }>(sql`
      select coalesce(
               jsonb_agg(incoming.payload order by incoming.sort_at desc, incoming.sort_id),
               '[]'::jsonb
             ) as body
        from (
          select jsonb_build_object(
                   'id', i.id,
                   'resident_name', coalesce(p.full_name, ''),
                   'emergency_type', i.emergency_type,
                   'activated_at', i.activated_at,
                   'status', i.status,
                   'sent_at', i.sent_at,
                   'renotified_at', i.renotified_at,
                   'resolved_at', i.resolved_at,
                   'resolved_reason', i.resolved_reason,
                   'auto_closed', i.auto_closed
                 ) as payload,
                 coalesce(i.resolved_at, i.sent_at, i.activated_at) as sort_at,
                 i.id as sort_id
            from public.incidents i
            left join public.profiles p
              on p.id = i.resident_id
           where ${incidentMemberView.where({ callerId, incident: incidentAlias('i') })}
        ) as incoming`);
    return result.rows[0].body;
  }

  /**
   * `get_incident_details`: IncidentDetails (19 keys) of one incident the caller may see as a member;
   * `share_payload` is the stored snapshot or `{}`. Undefined for an unknown id and for every denied
   * caller alike (the resident, `circle_id` null, a legacy status, pre-join, removed, pending,
   * outsider): all are `not_found`.
   */
  async details(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await tx.execute<{ body: Record<string, unknown> }>(sql`
      select jsonb_build_object(
               'id', rec.id,
               'resident_name', coalesce(p.full_name, ''),
               'emergency_type', rec.emergency_type,
               'activated_at', rec.activated_at,
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
               'share_payload', coalesce(rec.share_payload, '{}'::jsonb)
             ) as body
        from public.incidents rec
        left join public.profiles p
          on p.id = rec.resident_id
       where rec.id = ${incidentId}::uuid
         and ${incidentMemberView.where({ callerId, incident: incidentAlias('rec') })}`);
    return result.rows[0]?.body;
  }
}
