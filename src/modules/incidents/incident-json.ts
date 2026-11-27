import { sql } from 'drizzle-orm';

import { liveDeliverySql } from '../../common/policies';

/**
 * The resident's incident JSON shapes, built by Postgres exactly as the SQL helpers build them, for the
 * incident row aliased `rec`. Postgres writes the JSON so timestamps keep their microseconds and their
 * text form (the caller's transaction sets `TimeZone` to UTC first, see
 * `IncidentsRepository.useUtcTimestamps`), and floats keep Postgres' text (`NaN`, `Infinity`).
 */

/**
 * IncidentShared (spec §7.0): `_incident_activation_json(rec)` (final definition: baseline migration
 * 20261023140000), 22 keys, plus
 * `location_unavailable_since` (SCRUM-68, D74; jsonb orders keys, so its place in the text is fixed),
 * `place_name` and `country_code` (Stage 2 [B6] / [B9]). The body of attach location and set notes.
 */
export const INCIDENT_SHARED_JSON = sql`jsonb_build_object(
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
    'location_unavailable_since', rec.location_unavailable_since,
    'place_name', rec.place_name,
    'country_code', rec.country_code,
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
  )`;

/**
 * IncidentSend (spec §7.0): `_incident_send_json(rec)`, IncidentShared plus `delivered_count` and
 * `acknowledged_count`. Submit, the open read and re-notify use it, so their bodies are the same bytes
 * for the same row.
 */
export const INCIDENT_SEND_JSON = sql`(
  ${INCIDENT_SHARED_JSON}
  || jsonb_build_object(
    'delivered_count', (
      select count(*)::int
        from public.incident_deliveries d
       where d.incident_id = rec.id
         and ${liveDeliverySql('d')}
    ),
    'acknowledged_count', (
      select count(*)::int
        from public.incident_deliveries d
       where d.incident_id = rec.id
         and d.acknowledged_at is not null
         and ${liveDeliverySql('d')}
    )
  )
)`;
