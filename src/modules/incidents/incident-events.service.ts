import { Injectable } from '@nestjs/common';
import { isSQLWrapper, type SQL, sql } from 'drizzle-orm';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { incidentAlias, incidentEventsView, incidentResident } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import type { IncidentTransaction } from './incidents.repository';

/**
 * The known `incident_events.event_type` values (spec §5.6), with who writes each, its `detail` and
 * whether it happens at most once per incident. This is the list the API validates against
 * (API-100-22 AC2): `record()` refuses any other type in code, before it reaches the database.
 *
 * Adding a type: add it here (and to `ONCE_PER_INCIDENT` if it is a once-only lifecycle step). NOTE:
 * the baseline schema also has a CHECK constraint (`incident_events_type_allowed`, migration
 * 20261023140000) listing exactly these seven types, so a new type also needs an additive migration
 * that widens that constraint (and, if once-only, a new partial unique index); see the story report.
 */
export const INCIDENT_EVENT_TYPES = {
  /** Submit (created/promoted). `{recipient_count, recipient_ids (sorted), emergency_type}`. */
  alert_sent: { oncePerIncident: true },
  /** Submit (created/promoted). `{}`. */
  location_sharing_started: { oncePerIncident: true },
  /** Submit on an active incident, or explicit re-notify. `{recipient_count}` (rows refreshed). */
  renotified: { oncePerIncident: false },
  /** Mark safe. `{}`. */
  safe_recorded: { oncePerIncident: true },
  /** Mark safe. `{resolved_reason: "safe"}`. */
  incident_closed: { oncePerIncident: true },
  /** Mark safe. `{}`. */
  location_sharing_ended: { oncePerIncident: true },
  /** Mark safe. `{recipient_count, recipient_ids}`: members inside the window (rule 54), sorted. */
  closure_notified: { oncePerIncident: true },
} as const;

export type IncidentEventType = keyof typeof INCIDENT_EVENT_TYPES;

export function isKnownIncidentEventType(value: unknown): value is IncidentEventType {
  return typeof value === 'string' && Object.hasOwn(INCIDENT_EVENT_TYPES, value);
}

/**
 * The once-only types, in the order of the predicate of `incident_events_once_per_incident_uidx`.
 * `ON CONFLICT` names that predicate so Postgres uses the index as the arbiter.
 */
export const ONCE_PER_INCIDENT_EVENT_TYPES = [
  'alert_sent',
  'location_sharing_started',
  'location_sharing_ended',
  'safe_recorded',
  'incident_closed',
  'closure_notified',
] as const satisfies readonly IncidentEventType[];

/** `detail` keys only the resident (incident owner) may read (epic §18 D3, API-100-22 AC4). */
export const RESIDENT_ONLY_DETAIL_KEYS = ['recipient_ids'] as const;

/** A programming error: an event type the API does not know (never stored). */
export class UnknownIncidentEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`unknown incident event type: ${eventType}`);
    this.name = 'UnknownIncidentEventTypeError';
  }
}

/** An event row this transaction inserted. Ids and the type only (never the detail). */
export interface RecordedIncidentEvent {
  id: string;
  incident_id: string;
  event_type: IncidentEventType;
}

const ONCE_PREDICATE = sql.raw(
  `event_type in (${ONCE_PER_INCIDENT_EVENT_TYPES.map((type) => `'${type}'`).join(', ')})`,
);

/**
 * The one writer and reader of `incident_events` (API-100-22). Append-only: the API never updates or
 * deletes an event (AC5); there is no method that could.
 */
@Injectable()
export class IncidentEventService {
  /** Events inserted per open transaction, handed to the post-commit hook once it commits. */
  private readonly recorded = new WeakMap<object, RecordedIncidentEvent[]>();

  constructor(private readonly database: DatabaseService) {}

  /**
   * `GET /v1/incidents/{id}/events` (API-100-22 AC3): {@link listVisible} in a read-only transaction
   * in UTC (timestamps as the SQL functions return them). Unknown or hidden → 404
   * `incident_events:not_found` (the same body either way).
   */
  async read(user: AuthenticatedUser, incidentId: string): Promise<Record<string, unknown>[]> {
    const body = await this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        return this.listVisible(tx, incidentId, user.id);
      },
      { accessMode: 'read only' },
    );
    if (!body) throw new DomainError('incident_events:not_found');
    return body;
  }

  /**
   * `_incident_record_event`: inserts one event in the caller's transaction (server time `now()`).
   * A repeat of a once-only type is a no-op through `incident_events_once_per_incident_uidx`
   * (`ON CONFLICT DO NOTHING`) and returns undefined. `detail` is a JSON object, or a SQL expression
   * building one in the same statement (so ids and counts come from the transaction's own rows).
   */
  async record(
    tx: IncidentTransaction,
    incidentId: string,
    eventType: IncidentEventType,
    actorId: string | null,
    detail: SQL | Record<string, unknown> = {},
  ): Promise<RecordedIncidentEvent | undefined> {
    if (!isKnownIncidentEventType(eventType)) throw new UnknownIncidentEventTypeError(eventType);
    const detailSql = isSQLWrapper(detail) ? detail : sql`${JSON.stringify(detail)}::jsonb`;
    const result = await tx.execute<{ id: string }>(sql`
      insert into public.incident_events (incident_id, event_type, actor_id, detail)
      values (${incidentId}::uuid, ${eventType}::text, ${actorId}::uuid,
              coalesce(${detailSql}, '{}'::jsonb))
      on conflict (incident_id, event_type)
        where ${ONCE_PREDICATE}
      do nothing
      returning id::text as id`);
    const row = result.rows[0];
    if (!row) return undefined;
    const event: RecordedIncidentEvent = {
      id: row.id,
      incident_id: incidentId,
      event_type: eventType,
    };
    const list = this.recorded.get(tx) ?? [];
    list.push(event);
    this.recorded.set(tx, list);
    return event;
  }

  /** The events `tx` inserted so far, in insertion order; forgets them. */
  drain(tx: object): RecordedIncidentEvent[] {
    const list = this.recorded.get(tx) ?? [];
    this.recorded.delete(tx);
    return list;
  }

  /**
   * `GET /v1/incidents/{id}/events`: the incident's events ordered `occurred_at, id`, when the caller
   * passes `incident.eventsView` (the resident; or an active member inside the window while the
   * incident is `active`/`resolved`, rule 54). A caller who is not the resident never gets
   * `recipient_ids` (epic §18 D3); `recipient_count` stays. Undefined when the incident is unknown or
   * hidden from the caller (both `not_found`). One statement: the access check and the events come
   * from one snapshot.
   */
  async listVisible(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<Record<string, unknown>[] | undefined> {
    const incident = incidentAlias('rec');
    const hidden = sql.raw(`array[${RESIDENT_ONLY_DETAIL_KEYS.map((k) => `'${k}'`).join(', ')}]`);
    const result = await tx.execute<{ body: Record<string, unknown>[] }>(sql`
      select coalesce(
               (select jsonb_agg(
                         jsonb_build_object(
                           'id', e.id,
                           'event_type', e.event_type,
                           'occurred_at', e.occurred_at,
                           'actor_id', e.actor_id,
                           'detail', case
                                       when ${incidentResident.where({ callerId, incident })}
                                         then e.detail
                                       else e.detail - ${hidden}::text[]
                                     end
                         )
                         order by e.occurred_at, e.id
                       )
                  from public.incident_events e
                 where e.incident_id = rec.id),
               '[]'::jsonb
             ) as body
        from public.incidents rec
       where rec.id = ${incidentId}::uuid
         and ${incidentEventsView.where({ callerId, incident })}`);
    return result.rows[0]?.body;
  }
}
